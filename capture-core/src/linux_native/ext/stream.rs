//! One ext capture stream: its own thread and Wayland connection, an
//! `ext_image_copy_capture_session_v1` on a toplevel or output source, one SHM buffer, and frames
//! pulled into the [`Slot`] one after another.
//!
//! **Pacing.** The next frame is requested as soon as the previous one is ready, but no sooner
//! than [`MIN_INTERVAL`] after the previous request. The compositor completes a frame only when
//! the source has changed (the first frame of a session always completes), so an idle window
//! costs nothing; an animating one costs at most ~15 copies a second.
//!
//! **Orientation.** A frame's `transform` event says what the compositor did to the buffer (an
//! output's rotation, typically); the frame is turned upright before it is published. The ext
//! protocol has no y-invert flag (that was wlr-screencopy's): SHM buffers are always top-down.
use super::super::Feed;
use crate::linux_portal::backend::Slot;
use crate::linux_portal::PixelOrder;
use crate::{CaptureError, Result};
use rustix::event::{poll, PollFd, PollFlags};
use rustix::fd::{AsFd, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use wayland_client::globals::{registry_queue_init, GlobalListContents};
use wayland_client::protocol::{wl_buffer, wl_output, wl_registry, wl_shm, wl_shm_pool};
use wayland_client::{delegate_noop, event_created_child, Connection, Dispatch, EventQueue, QueueHandle, WEnum};
use wayland_protocols::ext::foreign_toplevel_list::v1::client::{
    ext_foreign_toplevel_handle_v1::{self, ExtForeignToplevelHandleV1},
    ext_foreign_toplevel_list_v1::{self, ExtForeignToplevelListV1},
};
use wayland_protocols::ext::image_capture_source::v1::client::{
    ext_foreign_toplevel_image_capture_source_manager_v1::ExtForeignToplevelImageCaptureSourceManagerV1,
    ext_image_capture_source_v1::ExtImageCaptureSourceV1,
    ext_output_image_capture_source_manager_v1::ExtOutputImageCaptureSourceManagerV1,
};
use wayland_protocols::ext::image_copy_capture::v1::client::{
    ext_image_copy_capture_frame_v1::{self, ExtImageCopyCaptureFrameV1, FailureReason},
    ext_image_copy_capture_manager_v1::{ExtImageCopyCaptureManagerV1, Options},
    ext_image_copy_capture_session_v1::{self, ExtImageCopyCaptureSessionV1},
};
use wayland_protocols::xdg::xdg_output::zv1::client::{
    zxdg_output_manager_v1::ZxdgOutputManagerV1,
    zxdg_output_v1::{self, ZxdgOutputV1},
};

/// At most ~15 frames a second.
pub const MIN_INTERVAL: Duration = Duration::from_millis(66);
/// How long `open` waits for the thread to find the source and start the session.
const START_WAIT: Duration = Duration::from_secs(3);
/// After this many failed frames in a row (no reason given) the stream gives up.
const MAX_FAILURES: u32 = 20;
const RETRY_AFTER_FAILURE: Duration = Duration::from_millis(250);

/// What to capture.
#[derive(Clone, Debug)]
pub enum Source {
    /// An ext toplevel, by its identifier.
    Toplevel(String),
    /// An output, by connector name.
    Output(String),
}

/// The stream thread; dropping it wakes the thread, which ends the session, and joins it.
struct Guard {
    wake: Option<OwnedFd>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Guard {
    fn drop(&mut self) {
        // Closing the pipe's write end wakes the thread's poll.
        drop(self.wake.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Start streaming `source` into a new slot.
pub fn open(source: Source) -> Result<Feed> {
    let slot = Arc::new(Slot::default());
    let finished = Arc::new(AtomicBool::new(false));
    let (wake_rx, wake_tx) = rustix::pipe::pipe_with(rustix::pipe::PipeFlags::CLOEXEC)
        .map_err(|e| CaptureError::new("native", format!("pipe: {e}")))?;
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread = {
        let (slot, finished) = (slot.clone(), finished.clone());
        std::thread::Builder::new()
            .name("kimochi-ext-capture".into())
            .spawn(move || {
                match Stream::start(&source, slot.clone()) {
                    Ok((queue, stream)) => {
                        let _ = ready_tx.send(Ok(()));
                        stream.run(queue, wake_rx);
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                    }
                }
                slot.end();
                finished.store(true, Ordering::SeqCst);
            })
            .map_err(|e| CaptureError::new("native", e))?
    };
    let guard = Guard { wake: Some(wake_tx), thread: Some(thread) };
    match ready_rx.recv_timeout(START_WAIT) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err(CaptureError::new("native", "The compositor did not start the capture in time")),
    }
    let gone = move || finished.load(Ordering::SeqCst);
    Ok(Feed::new(slot, gone, Box::new(guard)))
}

/// The wl_shm formats the stream reads, best first, and their byte order in memory
/// (wl_shm formats are little-endian: XRGB8888 is B, G, R, X in memory).
pub fn pick_format(offered: &[wl_shm::Format]) -> Option<(wl_shm::Format, PixelOrder)> {
    use wl_shm::Format;
    [
        (Format::Xrgb8888, PixelOrder::Bgrx),
        (Format::Argb8888, PixelOrder::Bgra),
        (Format::Xbgr8888, PixelOrder::Rgbx),
        (Format::Abgr8888, PixelOrder::Rgba),
    ]
    .into_iter()
    .find(|(f, _)| offered.contains(f))
}

/// Where the upright image's pixel (`x`, `y`) is in a buffer the compositor applied `transform`
/// to. `w`×`h` is the upright size. wl_output.transform: rotations are counter-clockwise, and
/// the flipped ones flip around the vertical axis before rotating.
fn buffer_point(transform: wl_output::Transform, x: u32, y: u32, w: u32, h: u32) -> (u32, u32) {
    use wl_output::Transform as T;
    let flipped = matches!(transform, T::Flipped | T::Flipped90 | T::Flipped180 | T::Flipped270);
    let x = if flipped { w - 1 - x } else { x };
    match transform {
        T::_90 | T::Flipped90 => (y, w - 1 - x),
        T::_180 | T::Flipped180 => (w - 1 - x, h - 1 - y),
        T::_270 | T::Flipped270 => (h - 1 - y, x),
        _ => (x, y),
    }
}

fn swaps_sides(transform: wl_output::Transform) -> bool {
    use wl_output::Transform as T;
    matches!(transform, T::_90 | T::_270 | T::Flipped90 | T::Flipped270)
}

/// A `width`×`height` 32-bit buffer the compositor applied `transform` to, upright, tightly
/// packed. Returns the pixels and the upright size.
pub fn untransform(data: &[u8], stride: usize, width: u32, height: u32, transform: wl_output::Transform) -> (Vec<u8>, u32, u32) {
    let (w, h) = if swaps_sides(transform) { (height, width) } else { (width, height) };
    let mut out = vec![0u8; w as usize * h as usize * 4];
    for (y, row) in out.chunks_exact_mut(w as usize * 4).enumerate() {
        for (x, px) in row.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            let (bx, by) = buffer_point(transform, x as u32, y as u32, w, h);
            let at = by as usize * stride + bx as usize * 4;
            px.copy_from_slice(&data[at..at + 4]);
        }
    }
    (out, w, h)
}

/// A wl_shm buffer on a memfd, mapped.
struct ShmBuffer {
    buffer: wl_buffer::WlBuffer,
    map: *mut std::ffi::c_void,
    len: usize,
    width: u32,
    height: u32,
    stride: u32,
    order: PixelOrder,
    _fd: OwnedFd,
}

impl ShmBuffer {
    fn new(shm: &wl_shm::WlShm, qh: &QueueHandle<Stream>, c: Constraints) -> std::io::Result<ShmBuffer> {
        use rustix::mm::{mmap, MapFlags, ProtFlags};
        let stride = c.width * 4;
        let len = stride as usize * c.height as usize;
        let fd = rustix::fs::memfd_create("kimochi-ext-capture", rustix::fs::MemfdFlags::CLOEXEC)?;
        rustix::fs::ftruncate(&fd, len as u64)?;
        // SAFETY: a fresh shared mapping of the whole memfd; unmapped in Drop, never aliased
        // mutably on our side (only the compositor writes into it).
        let map = unsafe { mmap(std::ptr::null_mut(), len, ProtFlags::READ | ProtFlags::WRITE, MapFlags::SHARED, &fd, 0)? };
        let pool = shm.create_pool(fd.as_fd(), len as i32, qh, ());
        let buffer = pool.create_buffer(0, c.width as i32, c.height as i32, stride as i32, c.format, qh, ());
        pool.destroy();
        Ok(ShmBuffer { buffer, map, len, width: c.width, height: c.height, stride, order: c.order, _fd: fd })
    }
    fn fits(&self, c: Constraints) -> bool {
        self.width == c.width && self.height == c.height && self.order == c.order
    }
    fn bytes(&self) -> &[u8] {
        // SAFETY: `map` is `len` bytes mapped for as long as `self` lives; the compositor does not
        // write while no capture is pending, which is when this is read.
        unsafe { std::slice::from_raw_parts(self.map as *const u8, self.len) }
    }
}

impl Drop for ShmBuffer {
    fn drop(&mut self) {
        self.buffer.destroy();
        // SAFETY: the mapping made in `new`.
        unsafe {
            let _ = rustix::mm::munmap(self.map, self.len);
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Constraints {
    width: u32,
    height: u32,
    format: wl_shm::Format,
    order: PixelOrder,
}

/// The stream thread's state.
struct Stream {
    slot: Arc<Slot>,
    shm: Option<wl_shm::WlShm>,
    session: Option<ExtImageCopyCaptureSessionV1>,
    // Constraints as the session sends them, applied on `done`.
    size: Option<(u32, u32)>,
    formats: Vec<wl_shm::Format>,
    constraints: Option<Constraints>,
    /// A frame failed on buffer constraints: wait for the session's new ones.
    awaiting_constraints: bool,
    buffer: Option<ShmBuffer>,
    frame: Option<ExtImageCopyCaptureFrameV1>,
    transform: wl_output::Transform,
    requested: Instant,
    next_at: Instant,
    failures: u32,
    stopped: Option<String>,
    // Finding the source.
    toplevels: Vec<(ExtForeignToplevelHandleV1, Option<String>)>,
    outputs: Vec<(wl_output::WlOutput, Option<String>)>,
}

impl Stream {
    fn new(slot: Arc<Slot>) -> Self {
        let now = Instant::now();
        Stream {
            slot,
            shm: None,
            session: None,
            size: None,
            formats: Vec::new(),
            constraints: None,
            awaiting_constraints: false,
            buffer: None,
            frame: None,
            transform: wl_output::Transform::Normal,
            requested: now,
            next_at: now,
            failures: 0,
            stopped: None,
            toplevels: Vec::new(),
            outputs: Vec::new(),
        }
    }

    /// Connect, find the source, start the session.
    fn start(source: &Source, slot: Arc<Slot>) -> Result<(EventQueue<Stream>, Stream)> {
        let fail = |e: &dyn std::fmt::Display| CaptureError::new("native", format!("Wayland: {e}"));
        let conn = Connection::connect_to_env().map_err(|e| fail(&e))?;
        let (globals, mut queue) = registry_queue_init::<Stream>(&conn).map_err(|e| fail(&e))?;
        let qh = queue.handle();
        let mut stream = Stream::new(slot);
        let manager: ExtImageCopyCaptureManagerV1 = globals.bind(&qh, 1..=1, ()).map_err(|e| fail(&e))?;
        stream.shm = Some(globals.bind(&qh, 1..=1, ()).map_err(|e| fail(&e))?);
        let capture_source: ExtImageCaptureSourceV1 = match source {
            Source::Toplevel(identifier) => {
                let list: ExtForeignToplevelListV1 = globals.bind(&qh, 1..=1, ()).map_err(|e| fail(&e))?;
                let sources: ExtForeignToplevelImageCaptureSourceManagerV1 =
                    globals.bind(&qh, 1..=1, ()).map_err(|e| fail(&e))?;
                // The toplevels, then their identifiers.
                queue.roundtrip(&mut stream).map_err(|e| fail(&e))?;
                queue.roundtrip(&mut stream).map_err(|e| fail(&e))?;
                list.stop();
                let mut found = None;
                for (handle, id) in stream.toplevels.drain(..) {
                    if found.is_none() && id.as_deref() == Some(identifier.as_str()) {
                        found = Some(handle);
                    } else {
                        handle.destroy();
                    }
                }
                let handle = found.ok_or_else(|| CaptureError::new("stale_source", "That window has closed"))?;
                let made = sources.create_source(&handle, &qh, ());
                sources.destroy();
                made
            }
            Source::Output(name) => {
                let sources: ExtOutputImageCaptureSourceManagerV1 = globals.bind(&qh, 1..=1, ()).map_err(|_| {
                    CaptureError::new("unsupported", "The compositor cannot capture whole outputs")
                })?;
                let xdg: Option<ZxdgOutputManagerV1> = globals.bind(&qh, 2..=3, ()).ok();
                let registry = globals.registry();
                globals.contents().with_list(|list| {
                    for (i, g) in list.iter().filter(|g| g.interface == "wl_output").enumerate() {
                        let output: wl_output::WlOutput = registry.bind(g.name, g.version.min(4), &qh, i);
                        if let Some(xdg) = &xdg {
                            xdg.get_xdg_output(&output, &qh, i);
                        }
                        stream.outputs.push((output, None));
                    }
                });
                queue.roundtrip(&mut stream).map_err(|e| fail(&e))?;
                let output = stream
                    .outputs
                    .iter()
                    .find(|(_, n)| n.as_deref() == Some(name.as_str()))
                    .map(|(o, _)| o.clone())
                    .ok_or_else(|| CaptureError::new("stale_source", "That display is gone"))?;
                let made = sources.create_source(&output, &qh, ());
                sources.destroy();
                made
            }
        };
        // Cursors stay out of captures (they would be read as text and cover it).
        stream.session = Some(manager.create_session(&capture_source, Options::empty(), &qh, ()));
        capture_source.destroy();
        manager.destroy();
        queue.flush().map_err(|e| fail(&e))?;
        Ok((queue, stream))
    }

    fn ready_to_request(&self) -> bool {
        self.frame.is_none() && self.constraints.is_some() && !self.awaiting_constraints && self.stopped.is_none()
    }

    fn request_frame(&mut self, qh: &QueueHandle<Stream>) {
        let (Some(c), Some(session), Some(shm)) = (self.constraints, &self.session, &self.shm) else { return };
        if !self.buffer.as_ref().is_some_and(|b| b.fits(c)) {
            self.buffer = None;
            match ShmBuffer::new(shm, qh, c) {
                Ok(b) => self.buffer = Some(b),
                Err(e) => {
                    self.stopped = Some(format!("SHM buffer: {e}"));
                    return;
                }
            }
        }
        let buffer = self.buffer.as_ref().expect("allocated above");
        let frame = session.create_frame(qh, ());
        frame.attach_buffer(&buffer.buffer);
        frame.damage_buffer(0, 0, buffer.width as i32, buffer.height as i32);
        frame.capture();
        self.transform = wl_output::Transform::Normal;
        self.requested = Instant::now();
        self.frame = Some(frame);
    }

    fn publish(&self) {
        let Some(b) = &self.buffer else { return };
        let data = b.bytes();
        if self.transform == wl_output::Transform::Normal {
            self.slot.publish_raw(data, 0, b.stride as i32, b.width, b.height, [0, 0, b.width, b.height], b.order);
        } else {
            let (pixels, w, h) = untransform(data, b.stride as usize, b.width, b.height, self.transform);
            self.slot.publish_raw(&pixels, 0, (w * 4) as i32, w, h, [0, 0, w, h], b.order);
        }
    }

    /// Pull frames until the session stops, the connection fails or `wake` is closed.
    fn run(mut self, mut queue: EventQueue<Stream>, wake: OwnedFd) {
        let qh = queue.handle();
        let end = loop {
            if let Err(e) = queue.dispatch_pending(&mut self) {
                break e.to_string();
            }
            if let Some(why) = self.stopped.take() {
                break why;
            }
            let now = Instant::now();
            if self.ready_to_request() && now >= self.next_at {
                self.request_frame(&qh);
                continue;
            }
            match queue.flush() {
                Err(wayland_client::backend::WaylandError::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => break e.to_string(),
                Ok(()) => {}
            }
            let Some(guard) = queue.prepare_read() else { continue };
            let timeout = self.ready_to_request().then(|| {
                let left = self.next_at.saturating_duration_since(now);
                rustix::event::Timespec { tv_sec: left.as_secs() as _, tv_nsec: left.subsec_nanos() as _ }
            });
            let (readable, woken) = {
                let mut fds = [
                    PollFd::from_borrowed_fd(guard.connection_fd(), PollFlags::IN),
                    PollFd::new(&wake, PollFlags::IN),
                ];
                match poll(&mut fds, timeout.as_ref()) {
                    Ok(_) | Err(rustix::io::Errno::INTR) => {}
                    Err(e) => break format!("poll: {e}"),
                }
                (!fds[0].revents().is_empty(), !fds[1].revents().is_empty())
            };
            if woken {
                break "closed".into();
            }
            if readable {
                match guard.read() {
                    Ok(_) => {}
                    Err(wayland_client::backend::WaylandError::Io(e)) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => break e.to_string(),
                }
            }
        };
        if end != "closed" {
            eprintln!("Wayland capture: ext stream ended: {end}");
        }
        if let Some(frame) = self.frame.take() {
            frame.destroy();
        }
        if let Some(session) = self.session.take() {
            session.destroy();
        }
        self.buffer = None;
        let _ = queue.flush();
    }
}

impl Dispatch<ExtImageCopyCaptureSessionV1, ()> for Stream {
    fn event(s: &mut Self, _: &ExtImageCopyCaptureSessionV1, event: ext_image_copy_capture_session_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        use ext_image_copy_capture_session_v1::Event;
        match event {
            Event::BufferSize { width, height } => s.size = Some((width, height)),
            Event::ShmFormat { format: WEnum::Value(format) } => s.formats.push(format),
            Event::Done => {
                let formats = std::mem::take(&mut s.formats);
                let Some((width, height)) = s.size.filter(|(w, h)| *w > 0 && *h > 0) else {
                    s.stopped = Some("the compositor gave no buffer size".into());
                    return;
                };
                let Some((format, order)) = pick_format(&formats) else {
                    s.stopped = Some(format!("no 32-bit RGB SHM format among {formats:?}"));
                    return;
                };
                s.constraints = Some(Constraints { width, height, format, order });
                s.awaiting_constraints = false;
            }
            Event::Stopped => s.stopped = Some("the source is gone".into()),
            _ => {}
        }
    }
}

impl Dispatch<ExtImageCopyCaptureFrameV1, ()> for Stream {
    fn event(s: &mut Self, frame: &ExtImageCopyCaptureFrameV1, event: ext_image_copy_capture_frame_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        use ext_image_copy_capture_frame_v1::Event;
        match event {
            Event::Transform { transform: WEnum::Value(t) } => s.transform = t,
            Event::Ready => {
                s.publish();
                s.failures = 0;
                s.next_at = Instant::now().max(s.requested + MIN_INTERVAL);
                frame.destroy();
                s.frame = None;
            }
            Event::Failed { reason } => {
                frame.destroy();
                s.frame = None;
                match reason {
                    WEnum::Value(FailureReason::BufferConstraints) => s.awaiting_constraints = true,
                    WEnum::Value(FailureReason::Stopped) => s.stopped = Some("the source is gone".into()),
                    _ => {
                        s.failures += 1;
                        if s.failures >= MAX_FAILURES {
                            s.stopped = Some("the compositor failed every frame".into());
                        }
                        s.next_at = Instant::now() + RETRY_AFTER_FAILURE;
                    }
                }
            }
            _ => {}
        }
    }
}

impl Dispatch<ExtForeignToplevelListV1, ()> for Stream {
    fn event(s: &mut Self, _: &ExtForeignToplevelListV1, event: ext_foreign_toplevel_list_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        if let ext_foreign_toplevel_list_v1::Event::Toplevel { toplevel } = event {
            s.toplevels.push((toplevel, None));
        }
    }
    event_created_child!(Stream, ExtForeignToplevelListV1, [
        ext_foreign_toplevel_list_v1::EVT_TOPLEVEL_OPCODE => (ExtForeignToplevelHandleV1, ()),
    ]);
}

impl Dispatch<ExtForeignToplevelHandleV1, ()> for Stream {
    fn event(s: &mut Self, proxy: &ExtForeignToplevelHandleV1, event: ext_foreign_toplevel_handle_v1::Event, _: &(), _: &Connection, _: &QueueHandle<Self>) {
        if let ext_foreign_toplevel_handle_v1::Event::Identifier { identifier } = event {
            if let Some(t) = s.toplevels.iter_mut().find(|(p, _)| p == proxy) {
                t.1 = Some(identifier);
            }
        }
    }
}

impl Dispatch<wl_output::WlOutput, usize> for Stream {
    fn event(s: &mut Self, _: &wl_output::WlOutput, event: wl_output::Event, i: &usize, _: &Connection, _: &QueueHandle<Self>) {
        if let wl_output::Event::Name { name } = event {
            s.outputs[*i].1 = Some(name);
        }
    }
}

impl Dispatch<ZxdgOutputV1, usize> for Stream {
    fn event(s: &mut Self, _: &ZxdgOutputV1, event: zxdg_output_v1::Event, i: &usize, _: &Connection, _: &QueueHandle<Self>) {
        if let zxdg_output_v1::Event::Name { name } = event {
            s.outputs[*i].1.get_or_insert(name);
        }
    }
}

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for Stream {
    fn event(_: &mut Self, _: &wl_registry::WlRegistry, _: wl_registry::Event, _: &GlobalListContents, _: &Connection, _: &QueueHandle<Self>) {}
}

delegate_noop!(Stream: ignore wl_shm::WlShm);
delegate_noop!(Stream: wl_shm_pool::WlShmPool);
delegate_noop!(Stream: ignore wl_buffer::WlBuffer);
delegate_noop!(Stream: ExtImageCopyCaptureManagerV1);
delegate_noop!(Stream: ExtForeignToplevelImageCaptureSourceManagerV1);
delegate_noop!(Stream: ExtOutputImageCaptureSourceManagerV1);
delegate_noop!(Stream: ExtImageCaptureSourceV1);
delegate_noop!(Stream: ZxdgOutputManagerV1);

#[cfg(test)]
mod tests {
    use super::*;
    use wl_output::Transform as T;
    use wl_shm::Format as F;

    #[test]
    fn formats_map_to_byte_order_best_first() {
        assert_eq!(pick_format(&[F::Abgr8888, F::Xrgb8888, F::Argb8888]), Some((F::Xrgb8888, PixelOrder::Bgrx)));
        assert_eq!(pick_format(&[F::Argb8888]), Some((F::Argb8888, PixelOrder::Bgra)));
        assert_eq!(pick_format(&[F::Xbgr8888, F::Abgr8888]), Some((F::Xbgr8888, PixelOrder::Rgbx)));
        assert_eq!(pick_format(&[F::Abgr8888]), Some((F::Abgr8888, PixelOrder::Rgba)));
        assert_eq!(pick_format(&[F::Rgb565, F::Xrgb2101010]), None);
    }

    /// A 3×2 image whose pixels are numbered 0..6 in reading order (one byte each, ×4).
    fn image(w: u32, h: u32) -> Vec<u8> {
        (0..w * h).flat_map(|i| [i as u8; 4]).collect()
    }
    fn ids(px: &[u8]) -> Vec<u8> {
        px.as_chunks::<4>().0.iter().map(|p| p[0]).collect()
    }

    #[test]
    fn transforms_come_back_upright() {
        // Upright:  0 1 2
        //           3 4 5
        // Rotated 90° counter-clockwise it is the 2×3 buffer
        //           2 5
        //           1 4
        //           0 3
        let buffer = [2u8, 5, 1, 4, 0, 3].iter().flat_map(|i| [*i; 4]).collect::<Vec<_>>();
        let (px, w, h) = untransform(&buffer, 8, 2, 3, T::_90);
        assert_eq!((w, h), (3, 2));
        assert_eq!(ids(&px), [0, 1, 2, 3, 4, 5]);
        // 180°: 5 4 3 / 2 1 0.
        let buffer = [5u8, 4, 3, 2, 1, 0].iter().flat_map(|i| [*i; 4]).collect::<Vec<_>>();
        assert_eq!(ids(&untransform(&buffer, 12, 3, 2, T::_180).0), [0, 1, 2, 3, 4, 5]);
        // Flipped: 2 1 0 / 5 4 3.
        let buffer = [2u8, 1, 0, 5, 4, 3].iter().flat_map(|i| [*i; 4]).collect::<Vec<_>>();
        assert_eq!(ids(&untransform(&buffer, 12, 3, 2, T::Flipped).0), [0, 1, 2, 3, 4, 5]);
        // Every transform: applying it and undoing it is the identity, with a padded stride.
        let upright = image(3, 2);
        for t in [T::Normal, T::_90, T::_180, T::_270, T::Flipped, T::Flipped90, T::Flipped180, T::Flipped270] {
            let (bw, bh) = if swaps_sides(t) { (2u32, 3u32) } else { (3, 2) };
            let stride = (bw as usize + 1) * 4;
            let mut buffer = vec![0xEEu8; stride * bh as usize];
            for y in 0..2 {
                for x in 0..3 {
                    let (bx, by) = buffer_point(t, x, y, 3, 2);
                    let at = by as usize * stride + bx as usize * 4;
                    buffer[at..at + 4].copy_from_slice(&upright[(y * 3 + x) as usize * 4..][..4]);
                }
            }
            let (px, w, h) = untransform(&buffer, stride, bw, bh, t);
            assert_eq!((w, h, px), (3, 2, upright.clone()), "{t:?}");
        }
    }
}

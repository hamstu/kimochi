//! Wayland capture: the xdg-desktop-portal ScreenCast portal plus a PipeWire stream
//! (plan Phase 7, v1 Wayland tier: portal capture + detached reader).
//!
//! **A session, not an inventory.** Wayland gives an unprivileged client no list of
//! windows or monitors. `request_permission` opens the system picker; whatever the user
//! shares there is the whole catalog until the session ends. `enumerate` lists only the
//! streams of the current session, and before the first pick it is empty. The UI shows
//! "Choose in system picker" (`Capabilities.system_picker_required`) and calls
//! `request_permission` from a user gesture.
//!
//! **Ids.** `portal:display:{node}` for a monitor (or a virtual output) and
//! `portal:window:{node}` for a window, `{node}` being the PipeWire node id of the
//! stream. They go through the shared `SourceId` codec like every other backend (the
//! codec has `display` and `window` kinds only; a third `stream` kind would parse as
//! "unknown source"). Node ids are meaningful only inside one portal session: a source
//! id from an earlier session is `stale_source`, never a guess.
//!
//! **Portal flow** (`request_permission`, blocking, call it on a worker):
//! `Screencast::new` → `create_session` → `select_sources(cursor hidden, monitor |
//! window, single selection, restore token, persist until revoked)` → `start` (the
//! picker; the compositor may skip it when the restore token is still valid) →
//! `open_pipe_wire_remote`. The portal's new restore token is handed to the
//! [`TokenStore`] (`set_portal_token_store`); tokens are single use, so a session that
//! returns none clears the stored one. The picker takes as long as the user does:
//! `request_permission` waits up to [`PICKER_TIMEOUT`] and then closes the session
//! (which dismisses the dialog) and returns `false`. Cancel and denial return `false`
//! too; `last_error` says which.
//!
//! **Threads.** Each session owns two threads. The portal thread runs the D-Bus flow
//! with `async_io::block_on` (ashpd on zbus's `async-io` runtime, which needs no tokio
//! context and matches the app's own `zbus`), then stays to watch the session's
//! `Closed` signal and to close the session when the backend stops it. The PipeWire
//! thread runs a `pw::MainLoop` connected through the portal's fd, one `pw::Stream` per
//! shared node, and copies each buffer into a latest-frame mailbox as tightly packed
//! RGBA (the same shape as `windows.rs`); `capture` waits at most 500 ms for a first
//! frame and otherwise copies the newest one.
//!
//! **Formats.** The stream offers BGRx, BGRA, RGBx and RGBA, SHM only: buffers are
//! `MemPtr` or `MemFd` (mapped by PipeWire), never DMA-BUF, because no modifier is
//! offered. Compositors that pad rows get a stride-aware copy; window streams that
//! carry a `VideoCrop` region (GNOME) are cut to it.
//!
//! **Coordinates.** A monitor stream's position and size are in the compositor's
//! logical coordinate space; frames are physical pixels. `Source.bounds` and
//! `FrameInfo.source_bounds` are that logical rectangle for monitors and `None` for
//! windows (Wayland does not disclose where a window is). `FrameInfo.scale_factor` is
//! frame pixels per logical unit, `frame width / logical width`, when the portal gave a
//! size, and 1.0 otherwise.
//!
//! The pure parts (ids, sources, format choice, stride-aware conversion, crop meta
//! handling) compile and are unit-tested on every host; the ashpd/PipeWire backend is
//! Linux-only.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use crate::{Platform, Rect, Source, SourceId};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(target_os = "linux")]
pub use backend::PortalCapture;

/// How long `request_permission` waits for the user to finish in the system picker.
pub const PICKER_TIMEOUT: Duration = Duration::from_secs(120);

// ----- Restore tokens --------------------------------------------------------------------

/// Where the portal's restore token lives between sessions and app launches. A valid
/// token lets the compositor reopen the same share without showing the picker again
/// (portal v4+, `PersistMode::ExplicitlyRevoked`). The app plugs in a store backed by
/// its settings; the default keeps the token in memory for this process only.
pub trait TokenStore: Send {
    fn get(&self) -> Option<String>;
    /// `None` forgets the token (tokens are single use; a session that returns none
    /// has invalidated the old one).
    fn set(&self, token: Option<&str>);
}

/// The default [`TokenStore`]: this process only.
#[derive(Default)]
pub struct MemoryTokenStore(Mutex<Option<String>>);

impl TokenStore for MemoryTokenStore {
    fn get(&self) -> Option<String> {
        self.0.lock().unwrap().clone()
    }
    fn set(&self, token: Option<&str>) {
        *self.0.lock().unwrap() = token.map(str::to_string);
    }
}

static TOKEN_STORE: Mutex<Option<Box<dyn TokenStore>>> = Mutex::new(None);
static LAST_PICK_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// Native failure text for the last portal pick, without exposing the restore token.
pub fn last_portal_pick_error() -> Option<String> { LAST_PICK_ERROR.lock().unwrap().clone() }

/// Install the restore-token store the Wayland backend uses. Call once at startup,
/// before or after `platform_backend()`; it is read at every pick. A no-op in effect on
/// other platforms (nothing reads it), so callers need no `cfg`.
pub fn set_portal_token_store(store: Box<dyn TokenStore>) {
    *TOKEN_STORE.lock().unwrap() = Some(store);
}

fn stored_token() -> Option<String> {
    let mut guard = TOKEN_STORE.lock().unwrap();
    guard
        .get_or_insert_with(|| Box::new(MemoryTokenStore::default()))
        .get()
        .filter(|t| !t.is_empty())
}

fn store_token(token: Option<&str>) {
    let mut guard = TOKEN_STORE.lock().unwrap();
    guard
        .get_or_insert_with(|| Box::new(MemoryTokenStore::default()))
        .set(token);
}

// ----- Streams and ids -------------------------------------------------------------------

/// What the portal said a stream is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StreamKind {
    Monitor,
    Window,
    /// A virtual output the compositor created for this share; captured like a monitor.
    Virtual,
}

/// One stream of the current portal session.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PortalStream {
    pub node_id: u32,
    pub kind: StreamKind,
    /// Compositor (logical) coordinates; monitors only.
    pub position: Option<(i32, i32)>,
    /// Compositor (logical) size, as displayed.
    pub size: Option<(i32, i32)>,
}

impl PortalStream {
    pub fn source_id(&self) -> String {
        match self.kind {
            StreamKind::Window => SourceId::Window {
                platform: Platform::Portal,
                handle: self.node_id.to_string(),
                pid: None,
            },
            StreamKind::Monitor | StreamKind::Virtual => {
                SourceId::display(Platform::Portal, self.node_id)
            }
        }
        .to_string()
    }

    /// Logical bounds: monitors only, and only when the portal sent both halves.
    pub fn bounds(&self) -> Option<Rect> {
        if self.kind == StreamKind::Window {
            return None;
        }
        let ((x, y), (w, h)) = (self.position?, self.size?);
        (w > 0 && h > 0).then(|| Rect {
            x: f64::from(x),
            y: f64::from(y),
            width: f64::from(w),
            height: f64::from(h),
        })
    }

    pub fn source(&self) -> Source {
        let (kind, name) = match self.kind {
            StreamKind::Window => ("window", "Shared window"),
            StreamKind::Monitor | StreamKind::Virtual => ("display", "Shared screen"),
        };
        Source {
            id: self.source_id(),
            kind,
            name: name.to_string(),
            app: None,
            bounds: self.bounds(),
            on_screen: None,
        }
    }
}

/// The PipeWire node a portal source id names, if it is one.
pub(crate) fn parse_stream_id(id: &str) -> Option<u32> {
    SourceId::parse(id)
        .filter(|p| p.platform() == Platform::Portal)?
        .handle_u32()
}

/// Frame pixels per compositor unit: the portal's sizes are logical, frames physical.
pub(crate) fn frame_scale(frame_width: u32, logical: Option<(i32, i32)>) -> f64 {
    match logical {
        Some((w, _)) if w > 0 && frame_width > 0 => f64::from(frame_width) / f64::from(w),
        _ => 1.0,
    }
}

// ----- Pixels ----------------------------------------------------------------------------

/// The 32-bit layouts the stream accepts, byte order in memory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PixelOrder {
    Bgrx,
    Bgra,
    Rgbx,
    Rgba,
}

impl PixelOrder {
    /// Offered to the compositor in this order. BGRx first: it is what GNOME, KDE and
    /// wlroots produce for SHM screencasts, so it is never a conversion on their side.
    pub const PREFERRED: [PixelOrder; 4] = [
        PixelOrder::Bgrx,
        PixelOrder::Bgra,
        PixelOrder::Rgbx,
        PixelOrder::Rgba,
    ];

    fn swaps_red_blue(self) -> bool {
        matches!(self, PixelOrder::Bgrx | PixelOrder::Bgra)
    }
    fn has_alpha(self) -> bool {
        matches!(self, PixelOrder::Bgra | PixelOrder::Rgba)
    }
}

/// The part of a `width` x `height` buffer that is the picture: the producer's
/// `VideoCrop` region `(x, y, w, h)` when it is valid and inside the buffer, else the
/// whole buffer.
pub(crate) fn crop_region(width: u32, height: u32, crop: Option<(i32, i32, u32, u32)>) -> [u32; 4] {
    let whole = [0, 0, width, height];
    let Some((x, y, w, h)) = crop else {
        return whole;
    };
    if x < 0 || y < 0 || w == 0 || h == 0 {
        return whole;
    }
    let (x, y) = (x as u32, y as u32);
    match (x.checked_add(w), y.checked_add(h)) {
        (Some(r), Some(b)) if r <= width && b <= height => [x, y, w, h],
        _ => whole,
    }
}

/// Copy `region` of one 32-bit plane into tightly packed RGBA8.
///
/// `data` is the mapped plane, `offset` the chunk offset to the first row and `stride`
/// the bytes per row (0 means tightly packed). Returns `None` for anything that does
/// not fit: a negative (bottom-up) or too-small stride, a region outside the frame, or
/// a plane shorter than the rows it claims. Padding alpha (`x` formats) becomes 255;
/// real alpha stays as delivered.
pub(crate) fn plane_to_rgba(
    data: &[u8],
    offset: usize,
    stride: i32,
    width: u32,
    height: u32,
    region: [u32; 4],
    order: PixelOrder,
) -> Option<Vec<u8>> {
    let [x, y, w, h] = region;
    if w == 0 || h == 0 || x.checked_add(w)? > width || y.checked_add(h)? > height {
        return None;
    }
    let row_bytes = width as usize * 4;
    let stride = match stride {
        0 => row_bytes,
        s if s < 0 => return None,
        s => s as usize,
    };
    if stride < row_bytes {
        return None;
    }
    let out_row = w as usize * 4;
    let first = offset.checked_add(y as usize * stride + x as usize * 4)?;
    let end = first.checked_add((h as usize - 1) * stride + out_row)?;
    if end > data.len() {
        return None;
    }
    let mut out = vec![0u8; out_row * h as usize];
    let swap = order.swaps_red_blue();
    let opaque = !order.has_alpha();
    for (row, target) in out.chunks_exact_mut(out_row).enumerate() {
        let from = first + row * stride;
        let line = &data[from..from + out_row];
        if !swap && !opaque {
            target.copy_from_slice(line);
            continue;
        }
        for (p, q) in line.chunks_exact(4).zip(target.chunks_exact_mut(4)) {
            let (r, b) = if swap { (p[2], p[0]) } else { (p[0], p[2]) };
            q[0] = r;
            q[1] = p[1];
            q[2] = b;
            q[3] = if opaque { 255 } else { p[3] };
        }
    }
    Some(out)
}

// ----- Backend ---------------------------------------------------------------------------

#[cfg(target_os = "linux")]
mod backend {
    use super::{
        crop_region, frame_scale, parse_stream_id, plane_to_rgba, store_token, stored_token,
        PixelOrder, PortalStream, StreamKind, PICKER_TIMEOUT,
    };
    use crate::pixels::{box_downscale, crop_pixels, fit_within, unpremultiply};
    use crate::{
        crop_rect, elapsed_ms, Capabilities, CaptureBackend, CaptureError, CaptureRequest, Crop,
        Frame, FrameInfo, Result, Source,
    };
    use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType};
    use ashpd::desktop::{PersistMode, ResponseError, Session};
    use futures_util::future::{select, Either};
    use futures_util::StreamExt;
    use pipewire as pw;
    use pw::spa;
    use spa::pod::{Object, Pod, Property, PropertyFlags, Value};
    use std::os::fd::OwnedFd;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{mpsc, Arc, Condvar, Mutex};
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    const FIRST_FRAME_WAIT: Duration = Duration::from_millis(500);
    /// Connecting to PipeWire through the portal's fd is local and quick.
    const PIPEWIRE_START_WAIT: Duration = Duration::from_secs(5);
    /// How often the portal thread looks at the stop flag while it waits on D-Bus.
    const STOP_POLL: Duration = Duration::from_millis(200);
    const MAX_PIXELS: u64 = 64_000_000;
    const PIXEL_FORMAT: &str = "RGBA8 straight alpha, top-left rows";
    const COLOR_SPACE: &str = "Display native (SDR; no embedded ICC profile)";

    fn native_error(e: impl ToString) -> CaptureError {
        CaptureError::new("native", e)
    }
    fn stale_source() -> CaptureError {
        CaptureError::new(
            "stale_source",
            "The shared screen or window has closed. Choose it again in the system picker.",
        )
    }
    fn not_picked() -> CaptureError {
        CaptureError::new(
            "permission",
            "Choose a screen or window to share in the system picker first.",
        )
    }

    // ----- Mailbox -----------------------------------------------------------------

    /// One frame, already converted to tightly packed RGBA.
    struct LatestFrame {
        received: Instant,
        pixels: Vec<u8>,
        width: u32,
        height: u32,
    }

    /// What one stream's PipeWire callbacks share with captures.
    #[derive(Default)]
    struct Slot {
        latest: Mutex<Option<Arc<LatestFrame>>>,
        arrived: Condvar,
        generation: AtomicU64,
        /// The stream has stopped: nothing more comes.
        ended: AtomicBool,
    }

    impl Slot {
        fn publish(&self, pixels: Vec<u8>, width: u32, height: u32) {
            self.generation.fetch_add(1, Ordering::SeqCst);
            *self.latest.lock().unwrap() = Some(Arc::new(LatestFrame {
                received: Instant::now(),
                pixels,
                width,
                height,
            }));
            self.arrived.notify_all();
        }
        fn end(&self) {
            self.ended.store(true, Ordering::SeqCst);
            self.arrived.notify_all();
        }
        /// The newest frame, waiting up to `limit` for the first one.
        fn frame(&self, limit: Duration, after: Option<Instant>) -> Option<Arc<LatestFrame>> {
            let latest = self.latest.lock().unwrap();
            let (latest, _) = self
                .arrived
                .wait_timeout_while(latest, limit, |frame| {
                    frame.as_ref().is_none_or(|frame| after.is_some_and(|after| frame.received < after)) && !self.ended.load(Ordering::SeqCst)
                })
                .unwrap();
            latest.clone().filter(|frame| after.is_none_or(|after| frame.received >= after))
        }
    }

    /// Flags the session's threads share.
    #[derive(Default)]
    struct Shared {
        /// The portal closed the session, or PipeWire dropped the stream.
        closed: AtomicBool,
        /// The backend wants the session gone.
        stop: AtomicBool,
    }

    // ----- Session -----------------------------------------------------------------

    /// One live portal session and its threads.
    struct Cast {
        streams: Vec<PortalStream>,
        slots: Vec<(u32, Arc<Slot>)>,
        shared: Arc<Shared>,
        pw_stop: Option<pw::channel::Sender<()>>,
        threads: Vec<JoinHandle<()>>,
    }

    impl Cast {
        fn alive(&self) -> bool {
            !self.shared.closed.load(Ordering::SeqCst)
                && !self
                    .slots
                    .iter()
                    .all(|(_, s)| s.ended.load(Ordering::SeqCst))
        }
        fn slot(&self, node: u32) -> Option<(&PortalStream, Arc<Slot>)> {
            let stream = self.streams.iter().find(|s| s.node_id == node)?;
            let slot = self.slots.iter().find(|(n, _)| *n == node)?.1.clone();
            Some((stream, slot))
        }
        fn stop(mut self) {
            self.shared.stop.store(true, Ordering::SeqCst);
            if let Some(tx) = self.pw_stop.take() {
                let _ = tx.send(());
            }
            for (_, slot) in &self.slots {
                slot.end();
            }
            // Both threads notice within `STOP_POLL` (portal) or at once (PipeWire).
            for thread in self.threads.drain(..) {
                let _ = thread.join();
            }
        }
    }

    /// What the portal hands back once the user has picked.
    struct Started {
        streams: Vec<PortalStream>,
        fd: OwnedFd,
        token: Option<String>,
    }

    enum PickError {
        Cancelled,
        Failed(String),
    }

    fn pick_error(e: ashpd::Error) -> PickError {
        match e {
            ashpd::Error::Response(ResponseError::Cancelled) => PickError::Cancelled,
            ashpd::Error::Response(ResponseError::Other) => {
                PickError::Failed("The portal refused the screen share".into())
            }
            ashpd::Error::PortalNotFound(_) => PickError::Failed(
                "No ScreenCast portal: install xdg-desktop-portal and your desktop's portal backend"
                    .into(),
            ),
            e => PickError::Failed(e.to_string()),
        }
    }

    fn stream_kind(t: Option<SourceType>) -> StreamKind {
        match t {
            Some(SourceType::Window) => StreamKind::Window,
            Some(SourceType::Virtual) => StreamKind::Virtual,
            // Portals older than v3 do not say; a monitor is the only thing they share.
            Some(SourceType::Monitor) | None => StreamKind::Monitor,
        }
    }

    /// SelectSources → Start → OpenPipeWireRemote on an existing session.
    async fn pick(
        proxy: &Screencast,
        session: &Session<Screencast>,
        token: Option<&str>,
    ) -> std::result::Result<Started, PickError> {
        let version = proxy.version();
        let wanted = SourceType::Monitor | SourceType::Window;
        let mut types = proxy
            .available_source_types()
            .await
            .map(|available| available & wanted)
            .unwrap_or(wanted);
        if types.is_empty() {
            types = SourceType::Monitor.into();
        }
        let mut options = SelectSourcesOptions::default()
            .set_cursor_mode(CursorMode::Hidden)
            .set_sources(types)
            .set_multiple(false);
        // Restore tokens and persistence arrived in ScreenCast v4.
        if version >= 4 {
            options = options
                .set_persist_mode(PersistMode::ExplicitlyRevoked)
                .set_restore_token(token);
        }
        proxy
            .select_sources(session, options)
            .await
            .map_err(pick_error)?
            .response()
            .map_err(pick_error)?;
        let response = proxy
            .start(session, None, Default::default())
            .await
            .map_err(pick_error)?
            .response()
            .map_err(pick_error)?;
        let streams: Vec<PortalStream> = response
            .streams()
            .iter()
            .map(|s| PortalStream {
                node_id: s.pipe_wire_node_id(),
                kind: stream_kind(s.source_type()),
                position: s.position(),
                size: s.size(),
            })
            .collect();
        if streams.is_empty() {
            return Err(PickError::Cancelled);
        }
        let fd = proxy
            .open_pipe_wire_remote(session, Default::default())
            .await
            .map_err(pick_error)?;
        Ok(Started {
            streams,
            fd,
            token: response.restore_token().map(str::to_string),
        })
    }

    async fn stop_requested(shared: &Shared) {
        while !shared.stop.load(Ordering::SeqCst) {
            async_io::Timer::after(STOP_POLL).await;
        }
    }

    /// The portal thread: run the pick, report it, then watch the session until it
    /// closes or the backend stops it.
    fn portal_thread(
        token: Option<String>,
        shared: Arc<Shared>,
        reply: mpsc::Sender<std::result::Result<Started, PickError>>,
    ) {
        async_io::block_on(async move {
            let proxy = match Screencast::new().await {
                Ok(p) => p,
                Err(e) => {
                    let _ = reply.send(Err(pick_error(e)));
                    return;
                }
            };
            let session = match proxy.create_session(Default::default()).await {
                Ok(s) => s,
                Err(e) => {
                    let _ = reply.send(Err(pick_error(e)));
                    return;
                }
            };
            // Subscribe before Start, so a close during the picker is not missed.
            let closed = session.receive_closed().await.ok();

            let picked = {
                let flow = std::pin::pin!(pick(&proxy, &session, token.as_deref()));
                let stopper = std::pin::pin!(stop_requested(&shared));
                match select(flow, stopper).await {
                    Either::Left((result, _)) => Some(result),
                    Either::Right(_) => None,
                }
            };
            let Some(picked) = picked else {
                // Timed out or stopped: closing the session dismisses the dialog.
                let _ = session.close().await;
                return;
            };
            let ok = picked.is_ok();
            if reply.send(picked).is_err() || !ok {
                let _ = session.close().await;
                return;
            }

            match closed {
                Some(closed) => {
                    let mut closed = std::pin::pin!(closed);
                    let stopper = std::pin::pin!(stop_requested(&shared));
                    match select(closed.next(), stopper).await {
                        Either::Left(_) => {
                            // Revoked from the compositor's indicator, or the source
                            // went away.
                            shared.closed.store(true, Ordering::SeqCst);
                        }
                        Either::Right(_) => {
                            let _ = session.close().await;
                        }
                    }
                }
                None => {
                    stop_requested(&shared).await;
                    let _ = session.close().await;
                }
            }
        });
    }

    // ----- PipeWire ----------------------------------------------------------------

    fn pixel_order(format: spa::param::video::VideoFormat) -> Option<PixelOrder> {
        use spa::param::video::VideoFormat as F;
        Some(match format {
            F::BGRx => PixelOrder::Bgrx,
            F::BGRA => PixelOrder::Bgra,
            F::RGBx => PixelOrder::Rgbx,
            F::RGBA => PixelOrder::Rgba,
            _ => return None,
        })
    }

    fn spa_format(order: PixelOrder) -> spa::param::video::VideoFormat {
        use spa::param::video::VideoFormat as F;
        match order {
            PixelOrder::Bgrx => F::BGRx,
            PixelOrder::Bgra => F::BGRA,
            PixelOrder::Rgbx => F::RGBx,
            PixelOrder::Rgba => F::RGBA,
        }
    }

    fn serialize(value: Value) -> Option<Vec<u8>> {
        spa::pod::serialize::PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &value)
            .ok()
            .map(|(cursor, _)| cursor.into_inner())
    }

    /// EnumFormat: raw video in one of our four layouts, any size, 10 fps preferred
    /// (OCR needs no more, and every frame is a CPU copy), at most 30. No modifier
    /// property, so producers stay on SHM buffers.
    fn enum_format() -> Option<Vec<u8>> {
        use spa::param::format::{FormatProperties, MediaSubtype, MediaType};
        use spa::param::ParamType;
        use spa::utils::{Fraction, Rectangle, SpaTypes};
        let [a, b, c, d] = PixelOrder::PREFERRED.map(spa_format);
        let object = spa::pod::object!(
            SpaTypes::ObjectParamFormat,
            ParamType::EnumFormat,
            spa::pod::property!(FormatProperties::MediaType, Id, MediaType::Video),
            spa::pod::property!(FormatProperties::MediaSubtype, Id, MediaSubtype::Raw),
            spa::pod::property!(
                FormatProperties::VideoFormat,
                Choice,
                Enum,
                Id,
                a,
                a,
                b,
                c,
                d
            ),
            spa::pod::property!(
                FormatProperties::VideoSize,
                Choice,
                Range,
                Rectangle,
                Rectangle {
                    width: 1920,
                    height: 1080
                },
                Rectangle {
                    width: 1,
                    height: 1
                },
                Rectangle {
                    width: 16384,
                    height: 16384
                }
            ),
            spa::pod::property!(
                FormatProperties::VideoFramerate,
                Choice,
                Range,
                Fraction,
                Fraction { num: 10, denom: 1 },
                Fraction { num: 0, denom: 1 },
                Fraction { num: 30, denom: 1 }
            ),
        );
        serialize(Value::Object(object))
    }

    /// Buffers: CPU-mappable memory only (no DMA-BUF).
    fn buffers_param() -> Option<Vec<u8>> {
        let types = (1u32 << spa::sys::SPA_DATA_MemPtr) | (1u32 << spa::sys::SPA_DATA_MemFd);
        serialize(Value::Object(Object {
            type_: spa::utils::SpaTypes::ObjectParamBuffers.as_raw(),
            id: spa::param::ParamType::Buffers.as_raw(),
            properties: vec![Property {
                key: spa::sys::SPA_PARAM_BUFFERS_dataType,
                flags: PropertyFlags::empty(),
                value: Value::Int(types as i32),
            }],
        }))
    }

    /// Meta: ask for the VideoCrop region (window streams on GNOME use it).
    fn crop_meta_param() -> Option<Vec<u8>> {
        serialize(Value::Object(Object {
            type_: spa::utils::SpaTypes::ObjectParamMeta.as_raw(),
            id: spa::param::ParamType::Meta.as_raw(),
            properties: vec![
                Property {
                    key: spa::sys::SPA_PARAM_META_type,
                    flags: PropertyFlags::empty(),
                    value: Value::Id(spa::utils::Id(spa::sys::SPA_META_VideoCrop)),
                },
                Property {
                    key: spa::sys::SPA_PARAM_META_size,
                    flags: PropertyFlags::empty(),
                    value: Value::Int(std::mem::size_of::<spa::sys::spa_meta_region>() as i32),
                },
            ],
        }))
    }

    #[derive(Clone, Copy)]
    struct Negotiated {
        order: PixelOrder,
        width: u32,
        height: u32,
    }

    struct StreamData {
        slot: Arc<Slot>,
        shared: Arc<Shared>,
        format: Option<Negotiated>,
    }

    type Ready = mpsc::Sender<std::result::Result<pw::channel::Sender<()>, String>>;

    fn pipewire_main(
        fd: OwnedFd,
        nodes: &[(u32, Arc<Slot>)],
        shared: &Arc<Shared>,
        ready: &Ready,
    ) -> std::result::Result<(), String> {
        let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(|e| e.to_string())?;
        let context = pw::context::ContextRc::new(&mainloop, None).map_err(|e| e.to_string())?;
        let core = context
            .connect_fd_rc(fd, None)
            .map_err(|e| format!("PipeWire refused the portal's connection: {e}"))?;
        let _core_listener = core
            .add_listener_local()
            .error({
                let shared = shared.clone();
                let weak = mainloop.downgrade();
                move |id, _seq, _res, _message| {
                    // An error on the core object means the connection is gone.
                    if id == pw::core::PW_ID_CORE {
                        shared.closed.store(true, Ordering::SeqCst);
                        if let Some(mainloop) = weak.upgrade() {
                            mainloop.quit();
                        }
                    }
                }
            })
            .register();

        let format = enum_format().ok_or("could not build the format request")?;
        let mut streams = Vec::new();
        for (node, slot) in nodes {
            let stream = pw::stream::StreamRc::new(
                core.clone(),
                "kimochi-capture",
                pw::properties::properties! {
                    *pw::keys::MEDIA_TYPE => "Video",
                    *pw::keys::MEDIA_CATEGORY => "Capture",
                    *pw::keys::MEDIA_ROLE => "Screen",
                },
            )
            .map_err(|e| e.to_string())?;
            let listener = stream
                .add_local_listener_with_user_data(StreamData {
                    slot: slot.clone(),
                    shared: shared.clone(),
                    format: None,
                })
                .state_changed(|_, data, old, new| {
                    use pw::stream::StreamState as S;
                    let gone = matches!(new, S::Error(_))
                        || (matches!(new, S::Unconnected) && !matches!(old, S::Unconnected));
                    if gone {
                        data.slot.end();
                        data.shared.closed.store(true, Ordering::SeqCst);
                    }
                })
                .param_changed(|stream, data, id, param| {
                    let Some(param) = param else { return };
                    if id != spa::param::ParamType::Format.as_raw() {
                        return;
                    }
                    let Ok((media, sub)) = spa::param::format_utils::parse_format(param) else {
                        return;
                    };
                    if media != spa::param::format::MediaType::Video
                        || sub != spa::param::format::MediaSubtype::Raw
                    {
                        return;
                    }
                    let mut info = spa::param::video::VideoInfoRaw::default();
                    data.format = info.parse(param).ok().and_then(|_| {
                        let size = info.size();
                        pixel_order(info.format()).map(|order| Negotiated {
                            order,
                            width: size.width,
                            height: size.height,
                        })
                    });
                    // The format is fixed: now say which buffers and metadata we take.
                    let (Some(buffers), Some(meta)) = (buffers_param(), crop_meta_param()) else {
                        return;
                    };
                    let mut params: Vec<&Pod> = [buffers.as_slice(), meta.as_slice()]
                        .into_iter()
                        .filter_map(Pod::from_bytes)
                        .collect();
                    let _ = stream.update_params(&mut params);
                })
                .process(|stream, data| {
                    let Some(format) = data.format else {
                        // Not negotiated yet (or unsupported): return what arrives.
                        while stream.dequeue_buffer().is_some() {}
                        return;
                    };
                    let Some(mut buffer) = stream.dequeue_buffer() else {
                        return;
                    };
                    // Only the newest matters; older ones go straight back.
                    while let Some(newer) = stream.dequeue_buffer() {
                        buffer = newer;
                    }
                    let crop = buffer
                        .find_meta::<spa::buffer::meta::MetaVideoCrop>()
                        .map(|m| m.meta_region())
                        .filter(|r| r.is_valid())
                        .map(|r| {
                            let (p, s) = (r.position(), r.size());
                            (p.x, p.y, s.width, s.height)
                        });
                    let datas = buffer.datas_mut();
                    let Some(plane) = datas.first_mut() else {
                        return;
                    };
                    let kind = plane.type_();
                    if kind != spa::buffer::DataType::MemPtr && kind != spa::buffer::DataType::MemFd
                    {
                        return;
                    }
                    let chunk = plane.chunk();
                    let (offset, size, stride) = (
                        chunk.offset() as usize,
                        chunk.size() as usize,
                        chunk.stride(),
                    );
                    if size == 0 || chunk.flags().contains(spa::buffer::ChunkFlags::CORRUPTED) {
                        return;
                    }
                    let Some(bytes) = plane.data() else { return };
                    let valid = &bytes[..bytes.len().min(offset.saturating_add(size))];
                    let (w, h) = (format.width, format.height);
                    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > MAX_PIXELS {
                        return;
                    }
                    let region = crop_region(w, h, crop);
                    if let Some(pixels) =
                        plane_to_rgba(valid, offset, stride, w, h, region, format.order)
                    {
                        data.slot.publish(pixels, region[2], region[3]);
                    }
                })
                .register()
                .map_err(|e| e.to_string())?;
            let format_pod = Pod::from_bytes(&format).ok_or("invalid format pod")?;
            stream
                .connect(
                    spa::utils::Direction::Input,
                    Some(*node),
                    pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
                    &mut [format_pod],
                )
                .map_err(|e| e.to_string())?;
            streams.push((stream, listener));
        }

        let (stop_tx, stop_rx) = pw::channel::channel::<()>();
        let weak = mainloop.downgrade();
        let _stop = stop_rx.attach(mainloop.loop_(), move |()| {
            if let Some(mainloop) = weak.upgrade() {
                mainloop.quit();
            }
        });
        ready
            .send(Ok(stop_tx))
            .map_err(|_| "capture backend went away".to_string())?;
        mainloop.run();
        for (stream, _) in &streams {
            let _ = stream.disconnect();
        }
        Ok(())
    }

    fn pipewire_thread(
        fd: OwnedFd,
        nodes: Vec<(u32, Arc<Slot>)>,
        shared: Arc<Shared>,
        ready: Ready,
    ) {
        if let Err(e) = pipewire_main(fd, &nodes, &shared, &ready) {
            let _ = ready.send(Err(e));
        }
        for (_, slot) in &nodes {
            slot.end();
        }
    }

    /// Start PipeWire for a picked session. On failure the portal session is closed.
    fn start_cast(started: Started, shared: Arc<Shared>, portal: JoinHandle<()>) -> Result<Cast> {
        let slots: Vec<(u32, Arc<Slot>)> = started
            .streams
            .iter()
            .map(|s| (s.node_id, Arc::new(Slot::default())))
            .collect();
        let (ready_tx, ready_rx) = mpsc::channel();
        let pw = {
            let (nodes, shared) = (slots.clone(), shared.clone());
            std::thread::Builder::new()
                .name("kimochi-pipewire".into())
                .spawn(move || pipewire_thread(started.fd, nodes, shared, ready_tx))
                .map_err(native_error)?
        };
        let mut cast = Cast {
            streams: started.streams,
            slots,
            shared,
            pw_stop: None,
            threads: vec![portal, pw],
        };
        match ready_rx.recv_timeout(PIPEWIRE_START_WAIT) {
            Ok(Ok(stop)) => {
                cast.pw_stop = Some(stop);
                Ok(cast)
            }
            Ok(Err(message)) => {
                cast.stop();
                Err(native_error(message))
            }
            Err(_) => {
                cast.stop();
                Err(native_error("PipeWire did not start in time"))
            }
        }
    }

    // ----- Backend -----------------------------------------------------------------

    /// xdg-desktop-portal ScreenCast + PipeWire. See the module docs.
    #[derive(Default)]
    pub struct PortalCapture {
        cast: Mutex<Option<Cast>>,
        /// Serialises pickers: a second request waits for the first, then reuses it.
        picking: Mutex<()>,
        last_error: Mutex<Option<String>>,
    }

    impl PortalCapture {
        pub fn new() -> Self {
            Self::default()
        }

        /// Why the last `request_permission` returned false ("cancelled" when the user
        /// dismissed the picker), or `None` after a successful pick.
        pub fn last_error(&self) -> Option<String> {
            self.last_error.lock().unwrap().clone()
        }

        fn live(&self) -> bool {
            self.cast.lock().unwrap().as_ref().is_some_and(Cast::alive)
        }

        fn drop_cast(&self) {
            let cast = self.cast.lock().unwrap().take();
            if let Some(cast) = cast {
                cast.stop();
            }
        }

        fn fail(&self, message: impl Into<String>) -> bool {
            let message = message.into();
            *super::LAST_PICK_ERROR.lock().unwrap() = Some(message.clone());
            *self.last_error.lock().unwrap() = Some(message);
            false
        }

        fn pick(&self) -> bool {
            let _picking = self.picking.lock().unwrap();
            if self.live() {
                return true;
            }
            // A dead session (revoked, source closed) is replaced by a fresh pick.
            self.drop_cast();
            let shared = Arc::new(Shared::default());
            let (tx, rx) = mpsc::channel();
            let portal = {
                let (token, shared) = (stored_token(), shared.clone());
                match std::thread::Builder::new()
                    .name("kimochi-portal".into())
                    .spawn(move || portal_thread(token, shared, tx))
                {
                    Ok(handle) => handle,
                    Err(e) => return self.fail(e.to_string()),
                }
            };
            let started = match rx.recv_timeout(PICKER_TIMEOUT) {
                Ok(Ok(started)) => started,
                Ok(Err(error)) => {
                    let _ = portal.join();
                    return match error {
                        PickError::Cancelled => { store_token(None); self.fail("cancelled") },
                        PickError::Failed(message) => self.fail(message),
                    };
                }
                Err(_) => {
                    // Still in the picker: closing the session takes the dialog down.
                    shared.stop.store(true, Ordering::SeqCst);
                    let _ = portal.join();
                    return self.fail("The system picker timed out");
                }
            };
            // Tokens are single use: keep the new one, or forget the spent one.
            store_token(started.token.as_deref());
            match start_cast(started, shared, portal) {
                Ok(cast) => {
                    *self.cast.lock().unwrap() = Some(cast);
                    *self.last_error.lock().unwrap() = None;
                    *super::LAST_PICK_ERROR.lock().unwrap() = None;
                    true
                }
                Err(e) => self.fail(e.message),
            }
        }

        /// The stream and mailbox behind a source id of the current session.
        fn resolve(&self, source_id: &str) -> Result<(PortalStream, Arc<Slot>)> {
            let node = parse_stream_id(source_id).ok_or_else(stale_source)?;
            let guard = self.cast.lock().unwrap();
            let cast = guard.as_ref().ok_or_else(not_picked)?;
            if !cast.alive() {
                return Err(stale_source());
            }
            let (stream, slot) = cast.slot(node).ok_or_else(stale_source)?;
            Ok((stream.clone(), slot))
        }

        fn grab(&self, source_id: &str, crop: Option<Crop>, edge: Option<u32>, after: Option<Instant>) -> Result<Frame> {
            let start = Instant::now();
            let (stream, slot) = self.resolve(source_id)?;
            // An isolated portal window does not contain separate layer surfaces;
            // hiding them may not damage this stream, so no new buffer is required.
            let after = if stream.kind == StreamKind::Window { None } else { after };
            let resolve_ms = elapsed_ms(start);
            let acquisition = Instant::now();
            let frame = slot.frame(FIRST_FRAME_WAIT, after).ok_or_else(|| {
                if slot.ended.load(Ordering::SeqCst) {
                    stale_source()
                } else {
                    native_error("The shared source produced no image in time; retry")
                }
            })?;
            let acquisition_ms = elapsed_ms(acquisition);

            let (fw, fh) = (frame.width, frame.height);
            if fw == 0 || fh == 0 || u64::from(fw) * u64::from(fh) > MAX_PIXELS {
                return Err(CaptureError::new(
                    "dimensions",
                    "Invalid or larger than 64 megapixel source",
                ));
            }
            let copying = Instant::now();
            let crop = crop_rect(crop, fw, fh)?;
            let mut pixels = if crop == [0, 0, fw, fh] {
                frame.pixels.clone()
            } else {
                crop_pixels(&frame.pixels, fw, crop)
            };
            let base_scale = frame_scale(fw, stream.size);
            let (mut info_crop, mut full, mut scale) = (crop, (fw, fh), base_scale);
            if let Some(edge) = edge {
                let (w, h) = fit_within(crop[2], crop[3], edge.max(1));
                if (w, h) != (crop[2], crop[3]) {
                    pixels = box_downscale(&pixels, crop[2], crop[3], w, h);
                }
                scale = base_scale * f64::from(w) / f64::from(fw);
                info_crop = [0, 0, w, h];
                full = (w, h);
            }
            // BGRA/RGBA screencasts are premultiplied; screens are opaque, so this is
            // nearly always a no-op pass.
            unpremultiply(&mut pixels);
            let [_, _, w, h] = info_crop;
            Ok(Frame {
                info: FrameInfo {
                    source_id: source_id.to_string(),
                    width: w,
                    height: h,
                    stride: w as usize * 4,
                    full_width: full.0,
                    full_height: full.1,
                    crop_pixels: info_crop,
                    scale_factor: scale,
                    source_bounds: stream.bounds(),
                    pixel_format: PIXEL_FORMAT,
                    color_space: COLOR_SPACE,
                    resolve_ms,
                    acquisition_ms,
                    pixels_ms: elapsed_ms(copying),
                    total_ms: elapsed_ms(start),
                },
                pixels,
            })
        }
    }

    impl CaptureBackend for PortalCapture {
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                backend: "xdg-portal-pipewire",
                enumeration: false,
                system_picker_required: true,
                retained_session: true,
            }
        }
        fn permission(&self) -> &'static str {
            if self.live() {
                "granted"
            } else {
                "promptOnSelect"
            }
        }
        /// Opens the system picker and blocks until the user shares something (true),
        /// cancels or is refused (false), or `PICKER_TIMEOUT` passes (false). Returns
        /// true at once while a session is live. Never call on the UI thread.
        fn request_permission(&self) -> bool {
            self.pick()
        }
        fn enumerate(&mut self) -> Result<Vec<Source>> {
            let guard = self.cast.lock().unwrap();
            Ok(match guard.as_ref() {
                Some(cast) if cast.alive() => {
                    cast.streams.iter().map(PortalStream::source).collect()
                }
                _ => Vec::new(),
            })
        }
        fn capture(&mut self, request: &CaptureRequest) -> Result<Frame> {
            self.grab(&request.source_id, request.crop, None, None)
        }
        fn capture_after(&mut self, request: &CaptureRequest, after: Instant) -> Result<Frame> {
            self.grab(&request.source_id, request.crop, None, Some(after))
        }
        fn thumbnail(&mut self, source_id: &str, edge: u32) -> Result<Frame> {
            self.grab(source_id, None, Some(edge), None)
        }
        fn thumbnail_after(&mut self, source_id: &str, edge: u32, after: Instant) -> Result<Frame> {
            self.grab(source_id, None, Some(edge), Some(after))
        }
        fn close(&mut self) {
            self.drop_cast();
        }
    }

    impl Drop for PortalCapture {
        fn drop(&mut self) {
            self.drop_cast();
        }
    }
    #[cfg(test)]
    mod freshness_tests {
        use super::*;
        #[test]
        fn cached_frame_before_suppression_is_never_returned() {
            let slot = Slot::default();
            slot.publish(vec![1; 4], 1, 1);
            let fence = Instant::now();
            assert!(slot.frame(Duration::from_millis(1), Some(fence)).is_none());
            slot.publish(vec![2; 4], 1, 1);
            assert_eq!(slot.frame(Duration::from_millis(1), Some(fence)).unwrap().pixels, vec![2; 4]);
        }
        #[test]
        fn capture_waits_for_a_post_suppression_frame() {
            let slot = Arc::new(Slot::default());
            slot.publish(vec![1; 4], 1, 1);
            let fence = Instant::now();
            let writer = slot.clone();
            let task = std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(10));
                writer.publish(vec![3; 4], 1, 1);
            });
            assert_eq!(slot.frame(Duration::from_secs(1), Some(fence)).unwrap().pixels, vec![3; 4]);
            task.join().unwrap();
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor() -> PortalStream {
        PortalStream {
            node_id: 57,
            kind: StreamKind::Monitor,
            position: Some((-1920, 0)),
            size: Some((1920, 1080)),
        }
    }

    #[test]
    fn stream_ids_use_the_shared_codec() {
        let m = monitor();
        assert_eq!(m.source_id(), "portal:display:57");
        assert_eq!(parse_stream_id("portal:display:57"), Some(57));
        let w = PortalStream {
            kind: StreamKind::Window,
            ..m
        };
        assert_eq!(w.source_id(), "portal:window:57");
        assert_eq!(parse_stream_id(&w.source_id()), Some(57));
        assert!(SourceId::parse(&w.source_id()).unwrap().is_window());
    }

    #[test]
    fn foreign_and_malformed_ids_are_not_streams() {
        for id in [
            "x11:display:57",
            "macos:window:57:1",
            "portal:stream:57",
            "portal:display:",
            "portal:display:node",
            "",
        ] {
            assert_eq!(parse_stream_id(id), None, "{id:?}");
        }
    }

    #[test]
    fn monitors_report_logical_bounds_windows_none() {
        let m = monitor().source();
        assert_eq!(m.kind, "display");
        assert_eq!(m.name, "Shared screen");
        let b = m.bounds.unwrap();
        assert_eq!(
            (b.x, b.y, b.width, b.height),
            (-1920.0, 0.0, 1920.0, 1080.0)
        );

        let w = PortalStream {
            kind: StreamKind::Window,
            position: Some((10, 10)),
            ..monitor()
        }
        .source();
        assert_eq!(w.kind, "window");
        assert_eq!(w.name, "Shared window");
        assert!(w.bounds.is_none());

        // A virtual output is captured like a monitor.
        let v = PortalStream {
            kind: StreamKind::Virtual,
            ..monitor()
        }
        .source();
        assert_eq!(v.kind, "display");

        // Half a rectangle is no rectangle.
        let partial = PortalStream {
            position: None,
            ..monitor()
        };
        assert!(partial.bounds().is_none());
    }

    #[test]
    fn scale_is_physical_over_logical() {
        assert_eq!(frame_scale(3840, Some((1920, 1080))), 2.0);
        assert_eq!(frame_scale(2400, Some((1920, 1080))), 1.25);
        assert_eq!(frame_scale(1920, None), 1.0);
        assert_eq!(frame_scale(1920, Some((0, 0))), 1.0);
    }

    #[test]
    fn bgrx_is_preferred_and_only_32_bit_layouts_are_offered() {
        assert_eq!(PixelOrder::PREFERRED[0], PixelOrder::Bgrx);
        assert_eq!(PixelOrder::PREFERRED.len(), 4);
    }

    /// A 3x2 frame in `order` with `pad` bytes of row padding, pixel (x, y) =
    /// red x*10, green y*10, blue 7, fourth byte 0 (garbage for `x` layouts).
    fn plane(order: PixelOrder, pad: usize) -> (Vec<u8>, i32) {
        let stride = 3 * 4 + pad;
        let mut data = vec![0xEE; stride * 2];
        for y in 0..2 {
            for x in 0..3 {
                let (r, g, b) = ((x * 10) as u8, (y * 10) as u8, 7u8);
                let p = &mut data[y * stride + x * 4..][..4];
                match order {
                    PixelOrder::Bgrx | PixelOrder::Bgra => p.copy_from_slice(&[b, g, r, 0]),
                    PixelOrder::Rgbx | PixelOrder::Rgba => p.copy_from_slice(&[r, g, b, 0]),
                }
            }
        }
        (data, stride as i32)
    }

    #[test]
    fn padded_rows_convert_for_every_layout() {
        for order in PixelOrder::PREFERRED {
            let (data, stride) = plane(order, 8);
            let out = plane_to_rgba(&data, 0, stride, 3, 2, [0, 0, 3, 2], order).unwrap();
            assert_eq!(out.len(), 3 * 2 * 4);
            let alpha = if order.has_alpha() { 0 } else { 255 };
            assert_eq!(&out[..4], &[0, 0, 7, alpha], "{order:?}");
            // (2, 1): the last pixel of the second row, past the first row's padding.
            assert_eq!(&out[20..24], &[20, 10, 7, alpha], "{order:?}");
        }
    }

    #[test]
    fn region_offset_and_zero_stride() {
        let (data, _) = plane(PixelOrder::Rgbx, 0);
        let mut shifted = vec![0u8; 16];
        shifted.extend_from_slice(&data);
        // Stride 0 means tightly packed; the chunk offset skips a 16-byte header.
        let out = plane_to_rgba(&shifted, 16, 0, 3, 2, [1, 1, 2, 1], PixelOrder::Rgbx).unwrap();
        assert_eq!(out, vec![10, 10, 7, 255, 20, 10, 7, 255]);
    }

    #[test]
    fn short_planes_and_bad_strides_are_rejected() {
        let (data, stride) = plane(PixelOrder::Bgrx, 0);
        let full = [0, 0, 3, 2];
        assert!(plane_to_rgba(
            &data[..data.len() - 1],
            0,
            stride,
            3,
            2,
            full,
            PixelOrder::Bgrx
        )
        .is_none());
        assert!(plane_to_rgba(&data, 0, -stride, 3, 2, full, PixelOrder::Bgrx).is_none());
        assert!(plane_to_rgba(&data, 0, 8, 3, 2, full, PixelOrder::Bgrx).is_none());
        assert!(plane_to_rgba(&data, 4, stride, 3, 2, full, PixelOrder::Bgrx).is_none());
        assert!(plane_to_rgba(&data, 0, stride, 3, 2, [2, 0, 2, 1], PixelOrder::Bgrx).is_none());
        assert!(plane_to_rgba(&data, 0, stride, 3, 2, [0, 0, 0, 1], PixelOrder::Bgrx).is_none());
    }

    #[test]
    fn crop_meta_is_used_only_when_it_fits() {
        assert_eq!(crop_region(100, 50, None), [0, 0, 100, 50]);
        assert_eq!(crop_region(100, 50, Some((10, 5, 80, 40))), [10, 5, 80, 40]);
        assert_eq!(crop_region(100, 50, Some((30, 0, 80, 40))), [0, 0, 100, 50]);
        assert_eq!(crop_region(100, 50, Some((-1, 0, 10, 10))), [0, 0, 100, 50]);
        assert_eq!(crop_region(100, 50, Some((0, 0, 0, 10))), [0, 0, 100, 50]);
        assert_eq!(
            crop_region(100, 50, Some((1, 1, u32::MAX, 1))),
            [0, 0, 100, 50]
        );
    }

    #[test]
    fn memory_token_store_round_trips_and_forgets() {
        let store = MemoryTokenStore::default();
        assert_eq!(store.get(), None);
        store.set(Some("abc"));
        assert_eq!(store.get().as_deref(), Some("abc"));
        store.set(None);
        assert_eq!(store.get(), None);
    }
}

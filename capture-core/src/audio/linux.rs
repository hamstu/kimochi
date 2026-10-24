//! System audio through PipeWire: a capture stream on the default output's monitor
//! (`stream.capture.sink`), on a main loop thread of its own. PipeWire is what desktop Linux,
//! SteamOS and the Steam Deck's Gaming Mode play sound through (PulseAudio apps included, by
//! pipewire-pulse); a system with only PulseAudio, or no PipeWire session, is reported
//! `unavailable` with the reason.
//!
//! The stream follows the default output when it changes (WirePlumber moves it). It asks for
//! 32-bit float at the graph's rate and channels and is downmixed to mono. Each buffer arrives one
//! graph cycle after it played, so it is stamped "it just finished playing" (accurate to a quantum,
//! about 20 ms). A suspended output delivers nothing; a timer pads the ring with silence then.
//!
//! PipeWire cannot leave one process out of a monitor, so Kimochi's own sounds are recorded too.
use super::{mono_frame, now_ms, Backend, Feed, Health, SampleFormat};
use crate::{CaptureError, Result};
use pipewire as pw;
use pw::spa;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// How long the stream may take to agree a format with the output before it counts as no output.
const NEGOTIATE: Duration = Duration::from_secs(4);
const TICK: Duration = Duration::from_millis(100);

pub(super) struct Stream {
    stop: Option<pw::channel::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    source: String,
}

impl Backend for Stream {
    fn source(&self) -> String {
        self.source.clone()
    }
    fn excludes_own_audio(&self) -> bool {
        false
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn unavailable(message: impl ToString) -> CaptureError {
    CaptureError::new("unavailable", message)
}

type Ready = mpsc::Sender<Result<(pw::channel::Sender<()>, String)>>;

pub(super) fn start(feed: Feed, health: Arc<Health>) -> Result<Stream> {
    let (ready_tx, ready_rx) = mpsc::channel();
    let thread = std::thread::Builder::new()
        .name("kimochi-pipewire-audio".into())
        .spawn(move || {
            let ready = Rc::new(RefCell::new(Some(ready_tx)));
            if let Err(e) = run(feed, health, ready.clone()) {
                if let Some(ready) = ready.borrow_mut().take() {
                    let _ = ready.send(Err(e));
                }
            }
        })
        .map_err(|e| CaptureError::new("native", e))?;
    match ready_rx.recv() {
        Ok(Ok((stop, source))) => Ok(Stream { stop: Some(stop), thread: Some(thread), source }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            let _ = thread.join();
            Err(CaptureError::new("native", "The PipeWire audio thread stopped before it started."))
        }
    }
}

/// What the stream's callbacks share with the loop's timer.
struct Shared {
    feed: Feed,
    health: Arc<Health>,
    rate: u32,
    channels: usize,
    /// Until the format is agreed: when connecting began, and who waits for it.
    pending: Option<(Instant, Ready, pw::channel::Sender<()>)>,
}

fn run(feed: Feed, health: Arc<Health>, ready: Rc<RefCell<Option<Ready>>>) -> Result<()> {
    pw::init();
    let no_pipewire = |e: pw::Error| {
        eprintln!("[audio] PipeWire: {e}");
        unavailable("PipeWire is not running, so Kimochi cannot record what this computer plays. Systems with only PulseAudio are not supported.")
    };
    let mainloop = pw::main_loop::MainLoopRc::new(None).map_err(no_pipewire)?;
    let context = pw::context::ContextRc::new(&mainloop, None).map_err(no_pipewire)?;
    let core = context.connect_rc(None).map_err(no_pipewire)?;

    let (stop_tx, stop_rx) = pw::channel::channel::<()>();
    let pending = ready.borrow_mut().take().map(|ready| (Instant::now(), ready, stop_tx.clone()));
    let shared = Rc::new(RefCell::new(Shared { feed, health: health.clone(), rate: 0, channels: 0, pending }));

    let _core_listener = core
        .add_listener_local()
        .error({
            let (health, weak) = (health.clone(), mainloop.downgrade());
            move |id, _seq, _res, message| {
                if id == pw::core::PW_ID_CORE {
                    health.end(format!("The connection to PipeWire was lost: {message}"));
                    if let Some(mainloop) = weak.upgrade() {
                        mainloop.quit();
                    }
                }
            }
        })
        .register();

    let stream = pw::stream::StreamRc::new(
        core.clone(),
        "kimochi-sentence-audio",
        pw::properties::properties! {
            *pw::keys::MEDIA_TYPE => "Audio",
            *pw::keys::MEDIA_CATEGORY => "Capture",
            *pw::keys::MEDIA_ROLE => "Music",
            *pw::keys::STREAM_CAPTURE_SINK => "true",
            *pw::keys::NODE_NAME => "kimochi-sentence-audio",
            *pw::keys::NODE_DESCRIPTION => "Kimochi sentence audio",
            *pw::keys::APP_NAME => "Kimochi",
        },
    )
    .map_err(|e| CaptureError::new("native", format!("PipeWire refused the audio stream: {e}")))?;

    let _listener = stream
        .add_local_listener_with_user_data(shared.clone())
        .state_changed({
            let weak = mainloop.downgrade();
            move |_, shared, old, new| {
                use pw::stream::StreamState as S;
                let gone = match &new {
                    S::Error(e) => Some(format!("PipeWire: {e}")),
                    S::Unconnected if !matches!(old, S::Unconnected) => Some("PipeWire closed the audio stream.".into()),
                    _ => None,
                };
                if let Some(why) = gone {
                    let mut shared = shared.borrow_mut();
                    match shared.pending.take() {
                        Some((_, ready, _)) => drop(ready.send(Err(unavailable(why)))),
                        None => shared.health.end(why),
                    }
                    if let Some(mainloop) = weak.upgrade() {
                        mainloop.quit();
                    }
                }
            }
        })
        .param_changed(|_, shared, id, param| {
            let Some(param) = param else { return };
            if id != spa::param::ParamType::Format.as_raw() {
                return;
            }
            let Ok((media, sub)) = spa::param::format_utils::parse_format(param) else { return };
            if media != spa::param::format::MediaType::Audio || sub != spa::param::format::MediaSubtype::Raw {
                return;
            }
            let mut info = spa::param::audio::AudioInfoRaw::default();
            if info.parse(param).is_err() || info.format() != spa::param::audio::AudioFormat::F32LE {
                return;
            }
            let mut shared = shared.borrow_mut();
            shared.rate = info.rate();
            shared.channels = info.channels() as usize;
            shared.feed.begin(now_ms(), info.rate());
            if let Some((_, ready, stop)) = shared.pending.take() {
                let source = format!("Everything this computer plays (PipeWire, {} Hz)", info.rate());
                let _ = ready.send(Ok((stop, source)));
            }
        })
        .process(|stream, shared| {
            let Some(mut buffer) = stream.dequeue_buffer() else { return };
            let mut shared = shared.borrow_mut();
            let (rate, channels) = (shared.rate, shared.channels);
            if rate == 0 || channels == 0 {
                return;
            }
            let Some(data) = buffer.datas_mut().first_mut() else { return };
            let (offset, size) = (data.chunk().offset() as usize, data.chunk().size() as usize);
            let Some(bytes) = data.data() else { return };
            let Some(bytes) = bytes.get(offset..offset.saturating_add(size).min(bytes.len())) else { return };
            let frames = bytes.len() / (channels * 4);
            let wall = now_ms() - frames as f64 * 1000.0 / rate as f64;
            if !shared.feed.push(wall, rate, frames, |i| mono_frame(bytes, channels, SampleFormat::F32, i)) {
                shared.health.dropped_chunks.fetch_add(1, Ordering::Relaxed);
            }
        })
        .register()
        .map_err(|e| CaptureError::new("native", e.to_string()))?;

    let format = format_pod().ok_or_else(|| CaptureError::new("native", "could not build the audio format request"))?;
    let format = spa::pod::Pod::from_bytes(&format).ok_or_else(|| CaptureError::new("native", "invalid audio format pod"))?;
    stream
        .connect(
            spa::utils::Direction::Input,
            None,
            pw::stream::StreamFlags::AUTOCONNECT | pw::stream::StreamFlags::MAP_BUFFERS,
            &mut [format],
        )
        .map_err(|e| CaptureError::new("native", format!("PipeWire would not connect the audio stream: {e}")))?;

    // Silence while the output is suspended, and giving up when no output ever answers.
    let timer = mainloop.loop_().add_timer({
        let (shared, weak) = (shared.clone(), mainloop.downgrade());
        move |_| {
            let mut shared = shared.borrow_mut();
            let late = shared.pending.as_ref().is_some_and(|(since, _, _)| since.elapsed() > NEGOTIATE);
            if late {
                if let Some((_, ready, _)) = shared.pending.take() {
                    let _ = ready.send(Err(unavailable("PipeWire has no sound output to record from.")));
                }
                if let Some(mainloop) = weak.upgrade() {
                    mainloop.quit();
                }
                return;
            }
            shared.feed.pad_silence(now_ms());
        }
    });
    let _ = timer.update_timer(Some(TICK), Some(TICK));

    let _stop = stop_rx.attach(mainloop.loop_(), {
        let weak = mainloop.downgrade();
        move |()| {
            if let Some(mainloop) = weak.upgrade() {
                mainloop.quit();
            }
        }
    });
    mainloop.run();
    let _ = stream.disconnect();
    Ok(())
}

/// 32-bit float, at whatever rate and channels the graph runs.
fn format_pod() -> Option<Vec<u8>> {
    let mut info = spa::param::audio::AudioInfoRaw::new();
    info.set_format(spa::param::audio::AudioFormat::F32LE);
    let object = spa::pod::Object {
        type_: spa::utils::SpaTypes::ObjectParamFormat.as_raw(),
        id: spa::param::ParamType::EnumFormat.as_raw(),
        properties: info.into(),
    };
    spa::pod::serialize::PodSerializer::serialize(std::io::Cursor::new(Vec::new()), &spa::pod::Value::Object(object))
        .ok()
        .map(|(cursor, _)| cursor.into_inner())
}

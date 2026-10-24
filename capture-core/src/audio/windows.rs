//! System audio through WASAPI loopback, on a thread of its own (COM, multithreaded apartment).
//!
//! First choice: **process loopback** (Windows 10 2004+), activated on the virtual
//! `VAD\Process_Loopback` device for everything *except* Kimochi's process tree, which leaves
//! out Kimochi's own sounds and its WebView2 processes (they are children of Kimochi). It follows
//! whatever device the sound plays on. Process loopback has no mix format of its own, so it is
//! asked for 48 kHz 16-bit stereo and converts to it.
//!
//! Fallback: **endpoint loopback** of the default output device in its mix format, Kimochi's
//! sounds included. It is checked every two seconds and ended when the default output changes,
//! so the service starts again on the new one.
//!
//! Both deliver nothing while nothing plays; `Feed::pad_silence` keeps the ring up with the clock.
//! Buffers are stamped from their QPC position (100 ns units) against `QueryPerformanceCounter`
//! now.
use super::{mono_frame, now_ms, Backend, Feed, Health, SampleFormat};
use crate::{CaptureError, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use windows::core::{implement, Interface, Ref, HRESULT, PWSTR};
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::StructuredStorage::{PropVariantToStringAlloc, PROPVARIANT};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IAgileObject, IAgileObject_Impl, BLOB, CLSCTX_ALL,
    COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;

/// The shared-mode buffer WASAPI keeps for us: 200 ms, drained every 20 ms.
const BUFFER_100NS: i64 = 2_000_000;
const POLL_MS: u32 = 20;
const DEVICE_CHECK: Duration = Duration::from_secs(2);
const WAVE_FORMAT_PCM: u16 = 1;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

pub(super) struct Stream {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    source: String,
    excludes: bool,
}

impl Backend for Stream {
    fn source(&self) -> String {
        self.source.clone()
    }
    fn excludes_own_audio(&self) -> bool {
        self.excludes
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn native(e: windows::core::Error) -> CaptureError {
    if e.code() == AUDCLNT_E_DEVICE_INVALIDATED {
        return CaptureError::new("unavailable", "The sound output device went away.");
    }
    CaptureError::new("native", format!("WASAPI: {} ({:#010x})", e.message(), e.code().0 as u32))
}

pub(super) fn start(feed: Feed, health: Arc<Health>) -> Result<Stream> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(String, bool)>>();
    let stop = Arc::new(AtomicBool::new(false));
    let thread = {
        let stop = stop.clone();
        std::thread::Builder::new()
            .name("kimochi-wasapi".into())
            .spawn(move || run(feed, health, stop, ready_tx))
            .map_err(|e| CaptureError::new("native", e))?
    };
    match ready_rx.recv() {
        Ok(Ok((source, excludes))) => Ok(Stream { stop, thread: Some(thread), source, excludes }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => Err(CaptureError::new("native", "The audio thread stopped before it started.")),
    }
}

fn run(mut feed: Feed, health: Arc<Health>, stop: Arc<AtomicBool>, ready: mpsc::Sender<Result<(String, bool)>>) {
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok();
    match open() {
        Ok(capture) => {
            let _ = ready.send(Ok((capture.source.clone(), capture.excludes)));
            if let Err(e) = capture.pump(&mut feed, &health, &stop) {
                health.end(e.message);
            }
            capture.close();
        }
        Err(e) => {
            let _ = ready.send(Err(e));
        }
    }
    if initialized {
        unsafe { CoUninitialize() };
    }
}

/// An initialised, started capture client.
struct Opened {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    event: HANDLE,
    format: SampleFormat,
    channels: usize,
    rate: u32,
    source: String,
    excludes: bool,
    /// Endpoint loopback: the device enumerator and the id of the device recorded.
    endpoint: Option<(IMMDeviceEnumerator, String)>,
}

fn open() -> Result<Opened> {
    // For testing the fallback on a Windows that has process loopback.
    if std::env::var_os("KIMOCHI_AUDIO_ENDPOINT_LOOPBACK").is_some() {
        return unsafe { open_endpoint_loopback() };
    }
    match unsafe { open_process_loopback() } {
        Ok(opened) => Ok(opened),
        Err(e) => {
            eprintln!("[audio] process loopback unavailable ({}); recording the default output instead", e.message);
            unsafe { open_endpoint_loopback() }
        }
    }
}

/// Signals when `ActivateAudioInterfaceAsync` has finished. Agile: it is called on a worker
/// thread of the audio service's choosing.
#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct Activation(Arc<(Mutex<bool>, Condvar)>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activation_Impl {
    fn ActivateCompleted(&self, _operation: Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        let (done, signal) = &*self.0;
        *done.lock().unwrap_or_else(|p| p.into_inner()) = true;
        signal.notify_all();
        Ok(())
    }
}

impl IAgileObject_Impl for Activation_Impl {}

unsafe fn open_process_loopback() -> Result<Opened> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: std::process::id(),
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    // A PROPVARIANT holding the parameters as a blob. It borrows `params` and owns nothing, so it
    // must never be cleared: `PROPVARIANT`'s Drop would PropVariantClear it and free `params`.
    let mut blob = std::mem::ManuallyDrop::new(PROPVARIANT::default());
    {
        let inner = &mut *blob.Anonymous.Anonymous;
        inner.vt = VT_BLOB;
        inner.Anonymous.blob = BLOB {
            cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            pBlobData: &mut params as *mut _ as *mut u8,
        };
    }
    let done = Arc::new((Mutex::new(false), Condvar::new()));
    let handler: IActivateAudioInterfaceCompletionHandler = Activation(done.clone()).into();
    let operation =
        ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*blob), &handler)
            .map_err(native)?;
    {
        let (finished, signal) = &*done;
        let guard = finished.lock().unwrap_or_else(|p| p.into_inner());
        let (guard, _) = signal
            .wait_timeout_while(guard, Duration::from_secs(5), |finished| !*finished)
            .unwrap_or_else(|p| p.into_inner());
        if !*guard {
            return Err(CaptureError::new("native", "Process loopback did not start in time."));
        }
    }
    let mut result = HRESULT(0);
    let mut activated = None;
    operation.GetActivateResult(&mut result, &mut activated).map_err(native)?;
    result.ok().map_err(native)?;
    let client: IAudioClient = activated
        .ok_or_else(|| CaptureError::new("native", "Process loopback gave no audio client."))?
        .cast()
        .map_err(native)?;
    let (rate, channels, bits) = (48_000u32, 2u16, 16u16);
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM,
        nChannels: channels,
        nSamplesPerSec: rate,
        wBitsPerSample: bits,
        nBlockAlign: channels * bits / 8,
        nAvgBytesPerSec: rate * (channels * bits / 8) as u32,
        cbSize: 0,
    };
    client
        .Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            BUFFER_100NS,
            0,
            &format,
            None,
        )
        .map_err(native)?;
    started(client, SampleFormat::I16, channels as usize, rate, "Everything this PC plays".into(), true, None)
}

unsafe fn open_endpoint_loopback() -> Result<Opened> {
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).map_err(native)?;
    let device = enumerator
        .GetDefaultAudioEndpoint(eRender, eConsole)
        .map_err(|_| CaptureError::new("unavailable", "There is no sound output device to record from."))?;
    let id = device_id(&device)?;
    let name = friendly_name(&device).unwrap_or_else(|| "the default sound output".into());
    let client: IAudioClient = device.Activate(CLSCTX_ALL, None).map_err(native)?;
    let mix = client.GetMixFormat().map_err(native)?;
    let parsed = parse_format(mix);
    let initialized = match &parsed {
        Ok(_) => client
            .Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK, BUFFER_100NS, 0, mix, None)
            .map_err(native),
        Err(_) => Ok(()),
    };
    CoTaskMemFree(Some(mix as *const _));
    let (format, channels, rate) = parsed?;
    initialized?;
    started(client, format, channels, rate, name, false, Some((enumerator, id)))
}

/// The sample format, channel count and rate of a mix format WASAPI reports.
unsafe fn parse_format(format: *const WAVEFORMATEX) -> Result<(SampleFormat, usize, u32)> {
    let f = &*format;
    let tag = if f.wFormatTag == WAVE_FORMAT_EXTENSIBLE && f.cbSize >= 22 {
        // KSDATAFORMAT_SUBTYPE_PCM and _IEEE_FLOAT carry the plain format tag in Data1.
        (*(format as *const WAVEFORMATEXTENSIBLE)).SubFormat.data1 as u16
    } else {
        f.wFormatTag
    };
    let sample = match (tag, f.wBitsPerSample) {
        (WAVE_FORMAT_IEEE_FLOAT, 32) => SampleFormat::F32,
        (WAVE_FORMAT_PCM, 16) => SampleFormat::I16,
        (WAVE_FORMAT_PCM, 32) => SampleFormat::I32,
        (tag, bits) => {
            return Err(CaptureError::new("native", format!("The sound output's format ({tag}, {bits}-bit) is not one Kimochi reads.")));
        }
    };
    Ok((sample, f.nChannels.max(1) as usize, f.nSamplesPerSec))
}

unsafe fn device_id(device: &IMMDevice) -> Result<String> {
    let id: PWSTR = device.GetId().map_err(native)?;
    let text = id.to_string().unwrap_or_default();
    CoTaskMemFree(Some(id.0 as *const _));
    Ok(text)
}

unsafe fn friendly_name(device: &IMMDevice) -> Option<String> {
    let store = device.OpenPropertyStore(STGM_READ).ok()?;
    let value = store.GetValue(&PKEY_Device_FriendlyName).ok()?;
    let text = PropVariantToStringAlloc(&value).ok()?;
    let name = text.to_string().ok();
    CoTaskMemFree(Some(text.0 as *const _));
    name.filter(|n| !n.is_empty())
}

unsafe fn started(
    client: IAudioClient,
    format: SampleFormat,
    channels: usize,
    rate: u32,
    source: String,
    excludes: bool,
    endpoint: Option<(IMMDeviceEnumerator, String)>,
) -> Result<Opened> {
    let event = CreateEventW(None, false, false, None).map_err(native)?;
    let opened = (|| {
        client.SetEventHandle(event).map_err(native)?;
        let capture: IAudioCaptureClient = client.GetService().map_err(native)?;
        client.Start().map_err(native)?;
        Ok(capture)
    })();
    match opened {
        Ok(capture) => Ok(Opened { client, capture, event, format, channels, rate, source, excludes, endpoint }),
        Err(e) => {
            let _ = CloseHandle(event);
            Err(e)
        }
    }
}

impl Opened {
    fn pump(&self, feed: &mut Feed, health: &Health, stop: &AtomicBool) -> Result<()> {
        let mut frequency = 0i64;
        unsafe { QueryPerformanceFrequency(&mut frequency) }.map_err(native)?;
        let block = self.channels * self.format.bytes();
        let mut checked = Instant::now();
        feed.begin(now_ms(), self.rate);
        while !stop.load(Ordering::SeqCst) {
            unsafe { WaitForSingleObject(self.event, POLL_MS) };
            loop {
                let pending = unsafe { self.capture.GetNextPacketSize() }.map_err(native)?;
                if pending == 0 {
                    break;
                }
                let (mut data, mut frames, mut flags, mut qpc) = (std::ptr::null_mut(), 0u32, 0u32, 0u64);
                unsafe { self.capture.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc)) }.map_err(native)?;
                let wall = stamp(qpc, frames, self.rate, frequency);
                let silent = flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 || data.is_null();
                let bytes: &[u8] = if silent { &[] } else { unsafe { std::slice::from_raw_parts(data, frames as usize * block) } };
                let (channels, format) = (self.channels, self.format);
                let pushed = feed.push(wall, self.rate, frames as usize, |i| if silent { 0.0 } else { mono_frame(bytes, channels, format, i) });
                if !pushed {
                    health.dropped_chunks.fetch_add(1, Ordering::Relaxed);
                }
                unsafe { self.capture.ReleaseBuffer(frames) }.map_err(native)?;
            }
            feed.pad_silence(now_ms());
            if checked.elapsed() >= DEVICE_CHECK {
                checked = Instant::now();
                if let Some((enumerator, id)) = &self.endpoint {
                    let current = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
                        .ok()
                        .and_then(|d| unsafe { device_id(&d) }.ok());
                    if current.as_deref() != Some(id.as_str()) {
                        return Err(CaptureError::new("unavailable", "The sound output changed."));
                    }
                }
            }
        }
        Ok(())
    }

    fn close(&self) {
        unsafe {
            let _ = self.client.Stop();
            let _ = CloseHandle(self.event);
        }
    }
}

/// When a buffer's first frame played, from its QPC position (100 ns units), or "it just
/// finished playing" when the position is missing or implausible.
fn stamp(qpc_100ns: u64, frames: u32, rate: u32, frequency: i64) -> f64 {
    let now_wall = now_ms();
    let mut counter = 0i64;
    let _ = unsafe { QueryPerformanceCounter(&mut counter) };
    let now_100ns = counter as f64 * 1e7 / frequency.max(1) as f64;
    let age_ms = (now_100ns - qpc_100ns as f64) / 1e4;
    if qpc_100ns != 0 && (0.0..5_000.0).contains(&age_ms) {
        now_wall - age_ms
    } else {
        now_wall - frames as f64 * 1000.0 / rate.max(1) as f64
    }
}

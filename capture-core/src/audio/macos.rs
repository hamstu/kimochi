//! System audio through ScreenCaptureKit: a stream of the main display with `capturesAudio`,
//! which hears everything the computer plays (whatever the output device) under the Screen
//! Recording permission Kimochi already asks for. Kimochi's own sounds are left out
//! (`excludesCurrentProcessAudio`). Core Audio's process taps would avoid the screen stream but
//! need macOS 14.6, and Kimochi supports 14.0.
//!
//! The stream's video is the smallest ScreenCaptureKit allows, at one frame a second, and
//! is thrown away. Each audio buffer's presentation time is on the host clock; it is turned
//! into wall-clock time against `mach_absolute_time` when the buffer arrives.
use super::{Feed, Health};
use crate::{CaptureError, Result};
use screencapturekit::{prelude::*, stream::ErrorHandler};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
}

#[repr(C)]
#[derive(Default)]
struct MachTimebaseInfo {
    numer: u32,
    denom: u32,
}

extern "C" {
    fn mach_absolute_time() -> u64;
    fn mach_timebase_info(info: *mut MachTimebaseInfo) -> i32;
}

/// The host clock now, in seconds: the clock ScreenCaptureKit's presentation times are on.
fn host_seconds() -> f64 {
    static TIMEBASE: std::sync::OnceLock<(u32, u32)> = std::sync::OnceLock::new();
    let (numer, denom) = *TIMEBASE.get_or_init(|| {
        let mut info = MachTimebaseInfo::default();
        unsafe { mach_timebase_info(&mut info) };
        (info.numer.max(1), info.denom.max(1))
    });
    (unsafe { mach_absolute_time() }) as f64 * numer as f64 / denom as f64 / 1e9
}

const SAMPLE_RATE: i32 = 48_000;
/// `kAudioFormatFlagIsFloat`, `kAudioFormatFlagIsNonInterleaved`.
const FLAG_FLOAT: u32 = 1 << 0;
const FLAG_NON_INTERLEAVED: u32 = 1 << 5;

pub(super) struct Stream {
    stream: SCStream,
}

impl Drop for Stream {
    fn drop(&mut self) {
        let _ = self.stream.stop_capture();
    }
}

pub(super) fn start(feed: Feed, health: Arc<Health>) -> Result<Stream> {
    if !unsafe { CGPreflightScreenCaptureAccess() } {
        return Err(CaptureError::new(
            "permission",
            "Kimochi needs the Screen Recording permission to record system audio.",
        ));
    }
    let content = SCShareableContent::get().map_err(|e| CaptureError::new("native", e))?;
    let display = content
        .displays()
        .into_iter()
        .next()
        .ok_or_else(|| CaptureError::new("native", "No display to record audio from."))?;
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();
    let config = SCStreamConfiguration::new()
        .with_width(2)
        .with_height(2)
        .with_shows_cursor(false)
        .with_minimum_frame_interval(&CMTime::new(1, 1))
        .with_queue_depth(3)
        .with_captures_audio(true)
        .with_sample_rate(SAMPLE_RATE)
        .with_channel_count(2)
        .with_excludes_current_process_audio(true);

    let on_error = health.clone();
    let mut stream = SCStream::new_with_delegate(
        &filter,
        &config,
        ErrorHandler::new(move |error| {
            *on_error.ended.lock().unwrap_or_else(|p| p.into_inner()) = Some(error.to_string());
        }),
    );
    // Video frames are not wanted, but a stream with no screen output logs every one it drops.
    stream.add_output_handler(|_: CMSampleBuffer, _: SCStreamOutputType| {}, SCStreamOutputType::Screen);
    let feed = Mutex::new(feed);
    let audio_health = health.clone();
    stream.add_output_handler(
        move |sample: CMSampleBuffer, kind: SCStreamOutputType| {
            if kind != SCStreamOutputType::Audio {
                return;
            }
            // Only this queue takes the lock, so it is never contended.
            let Ok(mut feed) = feed.try_lock() else { return };
            if !push_buffer(&mut feed, &sample) {
                audio_health.dropped_chunks.fetch_add(1, Ordering::Relaxed);
            }
        },
        SCStreamOutputType::Audio,
    );
    stream.start_capture().map_err(|e| CaptureError::new("native", e))?;
    Ok(Stream { stream })
}

/// Downmix one audio buffer into the feed, stamped with the wall-clock time its first sample
/// played. False when it was dropped (no room, or a format this does not read).
fn push_buffer(feed: &mut Feed, sample: &CMSampleBuffer) -> bool {
    let Some(format) = sample.format_description() else { return false };
    let rate = format.audio_sample_rate().unwrap_or(SAMPLE_RATE as f64);
    let flags = format.audio_format_flags().unwrap_or(FLAG_FLOAT | FLAG_NON_INTERLEAVED);
    let bits = format.audio_bits_per_channel().unwrap_or(32);
    let float = flags & FLAG_FLOAT != 0;
    if !((float && bits == 32) || (!float && bits == 16)) || rate < 1.0 {
        return false;
    }
    let Some(list) = sample.audio_buffer_list() else { return false };
    let buffers: Vec<(&[u8], usize)> = list
        .iter()
        .map(|b| (b.data(), b.number_channels().max(1) as usize))
        .collect();
    let width = if float { 4 } else { 2 };
    let channels: usize = buffers.iter().map(|(_, c)| c).sum();
    let Some(frames) = buffers.iter().map(|(data, c)| data.len() / (width * c)).min() else {
        return false;
    };
    if channels == 0 {
        return false;
    }

    let played_at = sample.presentation_timestamp().as_seconds();
    let now_wall = super::now_ms();
    let now_host = host_seconds();
    let wall_ms = match played_at {
        // Presentation times are host-clock times; anything far off is not, so fall back to
        // "it just finished playing".
        Some(pts) if (now_host - pts).abs() < 5.0 => now_wall - (now_host - pts) * 1000.0,
        _ => now_wall - frames as f64 * 1000.0 / rate,
    };

    let read = |data: &[u8], index: usize| -> f32 {
        if float {
            let at = index * 4;
            f32::from_ne_bytes([data[at], data[at + 1], data[at + 2], data[at + 3]])
        } else {
            let at = index * 2;
            i16::from_ne_bytes([data[at], data[at + 1]]) as f32 / 32768.0
        }
    };
    let scale = 1.0 / channels as f32;
    feed.push(wall_ms, rate.round() as u32, frames, |frame| {
        let mut sum = 0.0;
        for (data, count) in &buffers {
            for channel in 0..*count {
                sum += read(data, frame * count + channel);
            }
        }
        sum * scale
    })
}

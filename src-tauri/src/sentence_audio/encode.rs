//! MP3, the format every Anki client plays (AnkiMobile and AnkiDroid included), with LAME
//! (LGPL-3.0, built from source by mp3lame-sys: no ffmpeg, nothing to install).
use mp3lame_encoder::{max_required_buffer_size, Bitrate, Builder, FlushNoGap, Mode, MonoPcm, Quality};

/// Mono speech at 96 kbit/s: about 12 KB a second.
pub fn mp3(samples: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
    let fail = |e: &dyn std::fmt::Display| format!("mp3: {e}");
    let mut builder = Builder::new().ok_or("mp3: LAME did not start")?;
    builder.set_num_channels(1).map_err(|e| fail(&e))?;
    builder.set_sample_rate(sample_rate).map_err(|e| fail(&e))?;
    builder.set_mode(Mode::Mono).map_err(|e| fail(&e))?;
    builder.set_brate(Bitrate::Kbps96).map_err(|e| fail(&e))?;
    builder.set_quality(Quality::Good).map_err(|e| fail(&e))?;
    let mut encoder = builder.build().map_err(|e| fail(&e))?;
    let mut out = Vec::with_capacity(max_required_buffer_size(samples.len()) + 7_200);
    encoder.encode_to_vec(MonoPcm(samples), &mut out).map_err(|e| fail(&e))?;
    encoder.flush_to_vec::<FlushNoGap>(&mut out).map_err(|e| fail(&e))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tone_encodes_to_mp3_frames_of_about_the_right_size() {
        let rate = 48_000;
        let tone: Vec<f32> = (0..rate * 2).map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5).collect();
        let bytes = mp3(&tone, rate).unwrap();
        // An MPEG-1 Layer III frame header: 11 sync bits, then version 1, layer 3.
        assert_eq!((bytes[0], bytes[1] & 0xFE), (0xFF, 0xFA), "{:02X?}", &bytes[..4]);
        // Two seconds at 96 kbit/s is 24 KB.
        assert!((20_000..30_000).contains(&bytes.len()), "{}", bytes.len());
    }
}

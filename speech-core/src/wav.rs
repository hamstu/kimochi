//! Mono WAV in and out, for the lab (`speech-lab`) and the opt-in tests: 16-bit PCM or 32-bit
//! float, any rate; several channels are averaged on reading.
use std::path::Path;

/// The samples (mono, -1..1) and the sample rate.
pub fn read(path: &Path) -> Result<(Vec<f32>, u32), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let bad = || {
        format!(
            "{}: not a WAV file this reads (PCM 16-bit or float 32-bit)",
            path.display()
        )
    };
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad());
    }
    let (mut format, mut channels, mut rate, mut bits) = (0u16, 0u16, 0u32, 0u16);
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = u32::from_le_bytes(bytes[at + 4..at + 8].try_into().unwrap()) as usize;
        let body = &bytes[at + 8..(at + 8 + size).min(bytes.len())];
        if id == b"fmt " && body.len() >= 16 {
            format = u16::from_le_bytes([body[0], body[1]]);
            channels = u16::from_le_bytes([body[2], body[3]]);
            rate = u32::from_le_bytes(body[4..8].try_into().unwrap());
            bits = u16::from_le_bytes([body[14], body[15]]);
            if format == 0xFFFE && body.len() >= 26 {
                format = u16::from_le_bytes([body[24], body[25]]);
            }
        } else if id == b"data" {
            let channels = channels.max(1) as usize;
            let samples: Vec<f32> = match (format, bits) {
                (1, 16) => body
                    .chunks_exact(2)
                    .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32_768.0)
                    .collect(),
                (3, 32) => body
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                    .collect(),
                _ => return Err(bad()),
            };
            let mono = samples
                .chunks_exact(channels)
                .map(|c| c.iter().sum::<f32>() / channels as f32)
                .collect();
            return Ok((mono, rate));
        }
        at += 8 + size + (size & 1);
    }
    Err(bad())
}

/// Write mono 16-bit PCM.
pub fn write(path: &Path, samples: &[f32], rate: u32) -> Result<(), String> {
    let data = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32_767.0) as i16).to_le_bytes());
    }
    std::fs::write(path, out).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    #[test]
    fn what_is_written_reads_back() {
        let path =
            std::env::temp_dir().join(format!("kimochi-speech-wav-{}.wav", std::process::id()));
        let samples = vec![0.0, 0.5, -0.5, 0.25];
        super::write(&path, &samples, 16_000).unwrap();
        let (back, rate) = super::read(&path).unwrap();
        assert_eq!(rate, 16_000);
        assert!(
            back.iter().zip(&samples).all(|(a, b)| (a - b).abs() < 1e-3),
            "{back:?}"
        );
        let _ = std::fs::remove_file(path);
    }
}

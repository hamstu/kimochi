//! The features SenseVoice reads: Kaldi-style log mel filterbanks (80 bins, 25 ms frames every
//! 10 ms, Hamming window), stacked seven at a time every sixth frame (LFR) and normalised with the
//! model's own mean and deviation. The parameters are those sherpa-onnx feeds the same model with
//! (kaldi-native-fbank's defaults, plus Hamming, `normalize_samples = 0`), so the model sees what
//! it was converted and tested with.

const RATE: f32 = 16_000.0;
const FRAME: usize = 400;
const SHIFT: usize = 160;
const FFT: usize = 512;
pub const BINS: usize = 80;
const LOW_HZ: f32 = 20.0;
const PREEMPHASIS: f32 = 0.97;
/// Low frame rate: seven frames side by side, one set every six frames (60 ms).
pub const LFR_WINDOW: usize = 7;
pub const LFR_SHIFT: usize = 6;
pub const FEATURE: usize = BINS * LFR_WINDOW;
/// One LFR frame, in milliseconds.
pub const LFR_MS: f64 = (SHIFT * LFR_SHIFT) as f64 * 1000.0 / RATE as f64;

pub struct Fbank {
    window: Vec<f32>,
    /// Per mel bin: the first FFT bin it weighs, and the weights from there.
    banks: Vec<(usize, Vec<f32>)>,
    fft: Fft,
}

impl Default for Fbank {
    fn default() -> Self {
        Self::new()
    }
}

impl Fbank {
    pub fn new() -> Self {
        let window = (0..FRAME)
            .map(|i| 0.54 - 0.46 * (std::f32::consts::TAU * i as f32 / (FRAME - 1) as f32).cos())
            .collect();
        Self {
            window,
            banks: mel_banks(),
            fft: Fft::new(FFT),
        }
    }

    /// Log mel energies for 16 kHz mono samples in -1..1, one row of `BINS` per 10 ms.
    pub fn compute(&self, samples: &[f32]) -> Vec<[f32; BINS]> {
        if samples.len() < FRAME {
            return Vec::new();
        }
        let frames = 1 + (samples.len() - FRAME) / SHIFT;
        let mut out = Vec::with_capacity(frames);
        let mut frame = vec![0f32; FRAME];
        let mut re = vec![0f32; FFT];
        let mut im = vec![0f32; FFT];
        let mut power = vec![0f32; FFT / 2 + 1];
        for f in 0..frames {
            let start = f * SHIFT;
            // Kaldi reads 16-bit sample values.
            for (x, s) in frame.iter_mut().zip(&samples[start..start + FRAME]) {
                *x = s * 32_768.0;
            }
            let mean = frame.iter().sum::<f32>() / FRAME as f32;
            frame.iter_mut().for_each(|x| *x -= mean);
            for i in (1..FRAME).rev() {
                frame[i] -= PREEMPHASIS * frame[i - 1];
            }
            frame[0] -= PREEMPHASIS * frame[0];
            re.fill(0.0);
            im.fill(0.0);
            for i in 0..FRAME {
                re[i] = frame[i] * self.window[i];
            }
            self.fft.run(&mut re, &mut im);
            for (k, p) in power.iter_mut().enumerate() {
                *p = re[k] * re[k] + im[k] * im[k];
            }
            let mut row = [0f32; BINS];
            for (value, (first, weights)) in row.iter_mut().zip(&self.banks) {
                let energy: f32 = weights
                    .iter()
                    .zip(&power[*first..])
                    .map(|(w, p)| w * p)
                    .sum();
                *value = energy.max(f32::EPSILON).ln();
            }
            out.push(row);
        }
        out
    }
}

fn mel(hz: f32) -> f32 {
    1127.0 * (1.0 + hz / 700.0).ln()
}

/// Kaldi's triangular mel filters from 20 Hz to the Nyquist frequency.
fn mel_banks() -> Vec<(usize, Vec<f32>)> {
    let bin_hz = RATE / FFT as f32;
    let (low, high) = (mel(LOW_HZ), mel(RATE / 2.0));
    let delta = (high - low) / (BINS + 1) as f32;
    (0..BINS)
        .map(|b| {
            let left = low + b as f32 * delta;
            let (center, right) = (left + delta, left + 2.0 * delta);
            let mut first = None;
            let mut weights = Vec::new();
            for k in 0..FFT / 2 {
                let m = mel(k as f32 * bin_hz);
                if m > left && m < right {
                    first.get_or_insert(k);
                    weights.push(if m <= center {
                        (m - left) / (center - left)
                    } else {
                        (right - m) / (right - center)
                    });
                } else if first.is_some() {
                    break;
                }
            }
            (first.unwrap_or(0), weights)
        })
        .collect()
}

/// Stack `LFR_WINDOW` frames every `LFR_SHIFT` (as sherpa-onnx does: no padding, a partial last
/// window dropped), then normalise: `(x + neg_mean) * inv_stddev`.
pub fn lfr(frames: &[[f32; BINS]], neg_mean: &[f32], inv_stddev: &[f32]) -> Vec<f32> {
    if frames.len() < LFR_WINDOW {
        return Vec::new();
    }
    let count = (frames.len() - LFR_WINDOW) / LFR_SHIFT + 1;
    let mut out = Vec::with_capacity(count * FEATURE);
    for i in 0..count {
        for frame in &frames[i * LFR_SHIFT..i * LFR_SHIFT + LFR_WINDOW] {
            out.extend_from_slice(frame);
        }
    }
    for row in out.chunks_mut(FEATURE) {
        for ((x, m), s) in row.iter_mut().zip(neg_mean).zip(inv_stddev) {
            *x = (*x + m) * s;
        }
    }
    out
}

/// An in-place radix-2 complex FFT of a fixed power-of-two size.
struct Fft {
    n: usize,
    cos: Vec<f32>,
    sin: Vec<f32>,
}

impl Fft {
    fn new(n: usize) -> Self {
        let angle = |k: usize| -std::f64::consts::TAU * k as f64 / n as f64;
        Self {
            n,
            cos: (0..n / 2).map(|k| angle(k).cos() as f32).collect(),
            sin: (0..n / 2).map(|k| angle(k).sin() as f32).collect(),
        }
    }

    fn run(&self, re: &mut [f32], im: &mut [f32]) {
        let n = self.n;
        let mut j = 0;
        for i in 1..n {
            let mut bit = n >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j |= bit;
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let step = n / len;
            for start in (0..n).step_by(len) {
                for k in 0..len / 2 {
                    let (c, s) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (start + k, start + k + len / 2);
                    let (tr, ti) = (re[b] * c - im[b] * s, re[b] * s + im[b] * c);
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
            len <<= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fft_matches_a_direct_transform() {
        let n = 16;
        let signal: Vec<f32> = (0..n).map(|i| ((i * 7) % 5) as f32 - 2.0).collect();
        let (mut re, mut im) = (signal.clone(), vec![0.0; n]);
        Fft::new(n).run(&mut re, &mut im);
        for k in 0..n {
            let (mut r, mut i) = (0f64, 0f64);
            for (t, x) in signal.iter().enumerate() {
                let a = -std::f64::consts::TAU * (k * t) as f64 / n as f64;
                r += *x as f64 * a.cos();
                i += *x as f64 * a.sin();
            }
            assert!(
                (re[k] as f64 - r).abs() < 1e-3 && (im[k] as f64 - i).abs() < 1e-3,
                "bin {k}"
            );
        }
    }

    #[test]
    fn a_tone_lights_the_mel_bin_around_its_frequency() {
        let tone: Vec<f32> = (0..16_000)
            .map(|i| (i as f32 * 1_000.0 * std::f32::consts::TAU / RATE).sin() * 0.5)
            .collect();
        let frames = Fbank::new().compute(&tone);
        assert_eq!(frames.len(), 1 + (16_000 - FRAME) / SHIFT);
        let row = frames[50];
        let loudest = (0..BINS)
            .max_by(|&a, &b| row[a].total_cmp(&row[b]))
            .unwrap();
        // 1 kHz sits about a third of the way up the mel scale to 8 kHz.
        let expected = ((mel(1_000.0) - mel(LOW_HZ))
            / ((mel(8_000.0) - mel(LOW_HZ)) / (BINS + 1) as f32)) as usize;
        assert!(loudest.abs_diff(expected) <= 1, "{loudest} vs {expected}");
    }

    #[test]
    fn lfr_stacks_seven_frames_every_six() {
        let frames: Vec<[f32; BINS]> = (0..20).map(|i| [i as f32; BINS]).collect();
        let zero = vec![0.0; FEATURE];
        let one = vec![1.0; FEATURE];
        let out = lfr(&frames, &zero, &one);
        assert_eq!(out.len(), 3 * FEATURE);
        assert_eq!(out[FEATURE], 6.0);
        assert_eq!(out[FEATURE + 6 * BINS], 12.0);
        assert!(lfr(&frames[..6], &zero, &one).is_empty());
    }
}

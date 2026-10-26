//! Silero's speech probability over a stretch of a WAV, every 32 ms, streaming and whole-clip:
//! `KIMOCHI_ORT=… cargo run --example vad_probe -- file.wav [from_s] [to_s]`.
use kimochi_speech::vad::{self, Vad};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    ort::init_from(std::env::var("KIMOCHI_ORT").expect("KIMOCHI_ORT")).commit().unwrap();
    let (samples, rate) = kimochi_speech::wav::read(std::path::Path::new(&args[0])).unwrap();
    let from: f64 = args.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let to: f64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(samples.len() as f64 / rate as f64);
    let audio = vad::to_16k(&samples, rate);
    let mut stream = vad::Stream::new(Vad::new().unwrap());
    let probabilities = stream.push(&audio).unwrap();
    for (k, (p, rms)) in probabilities.iter().enumerate() {
        let t = k as f64 * vad::FRAME_MS / 1000.0;
        if t >= from && t <= to {
            println!("{t:6.2}  p {p:.2} {:<30} rms {rms:.3}", "#".repeat((p * 30.0) as usize));
        }
    }
}

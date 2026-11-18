//! Local-only cost probe for reading a game window with OCR in the background.
//!
//! Captures one window through the app's own backend (Windows Graphics Capture), encodes it
//! as the app does (RGB PNG), and has the OneOCR worker read it, at a chosen cadence. Reports
//! per-read capture / encode / OCR milliseconds, the worker's and the game's CPU time, and how
//! late a 60 Hz loop on this machine wakes (a stand-in for a game's frame loop competing for
//! the CPU). Prints timings only; with `--text` it also prints what was read, for checking
//! that the read is real.
//!
//! Usage (Windows):
//!   cargo run --release -p kimochi-capture --example witness_cost -- \
//!     --pid <game pid> --worker <kimochi-oneocr-*.exe> --runtime <dir with oneocr.dll> \
//!     [--interval-ms 0] [--count 20] [--idle-s 10] [--crop-bottom 0.4] [--text]
//!
//! `--interval-ms 0` reads back to back; `--idle-s` measures the same counters with no reads
//! first, as the baseline.
#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("witness_cost runs on Windows only");
}

#[cfg(target_os = "windows")]
fn main() {
    imp::main();
}

#[cfg(target_os = "windows")]
mod imp {
    use kimochi_capture::{platform_backend, CaptureRequest, Crop};
    use std::io::{BufRead, BufReader, Write};
    use std::os::windows::io::AsRawHandle;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{CloseHandle, FILETIME, HANDLE};
    use windows::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    fn arg(name: &str) -> Option<String> {
        let args: Vec<String> = std::env::args().collect();
        args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
    }
    fn flag(name: &str) -> bool {
        std::env::args().any(|a| a == name)
    }

    fn b64(data: &[u8]) -> String {
        const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
        for chunk in data.chunks(3) {
            let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for i in 0..4 {
                if i <= chunk.len() {
                    out.push(T[((n >> (18 - 6 * i)) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    fn ft(f: FILETIME) -> f64 {
        ((u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)) as f64 / 10_000.0
    }
    /// Kernel + user CPU milliseconds of a process so far.
    fn cpu_ms(handle: HANDLE) -> f64 {
        let (mut c, mut e, mut k, mut u) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        if unsafe { GetProcessTimes(handle, &mut c, &mut e, &mut k, &mut u) }.is_err() {
            return f64::NAN;
        }
        ft(k) + ft(u)
    }

    /// A 60 Hz loop that records how late each wake-up is.
    fn pacing(stop: Arc<AtomicBool>, late: Arc<Mutex<Vec<f64>>>) -> std::thread::JoinHandle<()> {
        std::thread::spawn(move || {
            let period = Duration::from_micros(16_667);
            let mut next = Instant::now() + period;
            while !stop.load(Ordering::Relaxed) {
                // Sleep to 2 ms before the tick (the timer's granularity), then wait it out, as a
                // game's frame limiter does; what is left is the scheduler making the loop wait.
                let now = Instant::now();
                if next > now + Duration::from_millis(2) {
                    std::thread::sleep(next - now - Duration::from_millis(2));
                }
                while Instant::now() < next {
                    std::thread::yield_now();
                }
                let woke = Instant::now();
                late.lock().unwrap().push(woke.saturating_duration_since(next).as_secs_f64() * 1000.0);
                // Simulate a little frame work.
                let spin = Instant::now();
                while spin.elapsed() < Duration::from_millis(2) {
                    std::hint::spin_loop();
                }
                next += period;
                if next < Instant::now() {
                    next = Instant::now() + period;
                }
            }
        })
    }

    fn pct(v: &mut [f64], p: f64) -> f64 {
        if v.is_empty() {
            return f64::NAN;
        }
        v.sort_by(f64::total_cmp);
        v[((v.len() - 1) as f64 * p).round() as usize]
    }

    struct Window {
        late: Arc<Mutex<Vec<f64>>>,
        game0: f64,
        worker0: f64,
        me0: f64,
        t0: Instant,
    }

    pub fn main() {
        let pid: u32 = arg("--pid").and_then(|p| p.parse().ok()).expect("--pid <game pid>");
        let worker_exe = arg("--worker").expect("--worker <exe>");
        let runtime = arg("--runtime").expect("--runtime <dir>");
        let interval = Duration::from_millis(arg("--interval-ms").and_then(|v| v.parse().ok()).unwrap_or(0));
        let count: usize = arg("--count").and_then(|v| v.parse().ok()).unwrap_or(20);
        let idle_s: u64 = arg("--idle-s").and_then(|v| v.parse().ok()).unwrap_or(10);
        let crop_bottom: Option<f64> = arg("--crop-bottom").and_then(|v| v.parse().ok());
        let label = arg("--label").unwrap_or_else(|| "run".into());
        let show_text = flag("--text");

        let mut backend = platform_backend().expect("capture backend");
        let sources = backend.enumerate().expect("enumerate");
        let source = sources
            .iter()
            .filter(|s| s.kind == "window" && s.id.ends_with(&format!(":{pid}")))
            .max_by_key(|s| s.bounds.map(|b| (b.width * b.height) as i64).unwrap_or(0))
            .unwrap_or_else(|| panic!("no window for pid {pid}"))
            .clone();
        eprintln!("source {} {:?} {:?}", source.id, source.name, source.bounds);

        let game = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.expect("open game");
        let me = unsafe { windows::Win32::System::Threading::GetCurrentProcess() };

        // The worker, started once, as the app keeps it.
        let started = Instant::now();
        let mut child = Command::new(&worker_exe)
            .arg(&runtime)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("worker");
        let worker = HANDLE(child.as_raw_handle());
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).expect("ready");
        eprintln!("worker pid {} ready in {:.0} ms: {}", child.id(), started.elapsed().as_secs_f64() * 1000.0, line.trim());

        let stop = Arc::new(AtomicBool::new(false));
        let late = Arc::new(Mutex::new(Vec::new()));
        let probe = pacing(stop.clone(), late.clone());
        let begin = |late: &Arc<Mutex<Vec<f64>>>| {
            late.lock().unwrap().clear();
            Window { late: late.clone(), game0: cpu_ms(game), worker0: cpu_ms(worker), me0: cpu_ms(me), t0: Instant::now() }
        };
        let end = |w: Window, phase: &str, reads: usize| {
            let wall = w.t0.elapsed().as_secs_f64() * 1000.0;
            let mut l = w.late.lock().unwrap().clone();
            let n = l.len();
            let over = l.iter().filter(|x| **x > 4.0).count();
            println!(
                "SUMMARY {label} {phase}: wall {:.0} ms, reads {reads}, game cpu {:.1}%, worker cpu {:.0} ms ({:.1}% of one core), harness cpu {:.0} ms, pacing p50 {:.2} p95 {:.2} p99 {:.2} max {:.2} ms, >4ms late {}/{}",
                wall,
                (cpu_ms(game) - w.game0) / wall * 100.0,
                cpu_ms(worker) - w.worker0,
                (cpu_ms(worker) - w.worker0) / wall * 100.0,
                cpu_ms(me) - w.me0,
                pct(&mut l, 0.5),
                pct(&mut l, 0.95),
                pct(&mut l, 0.99),
                pct(&mut l, 1.0),
                over,
                n
            );
        };

        if idle_s > 0 {
            let w = begin(&late);
            std::thread::sleep(Duration::from_secs(idle_s));
            end(w, "idle", 0);
        }

        println!("read,capture_ms,encode_ms,ocr_ms,worker_cpu_ms,png_kb,width,height,lines,chars");
        let full = backend
            .capture(&CaptureRequest { source_id: source.id.clone(), crop: None })
            .expect("first capture");
        let (full_w, full_h) = (full.info.full_width, full.info.full_height);
        eprintln!("frame {full_w}x{full_h}");
        drop(full);
        let w = begin(&late);
        let mut ocr_all = Vec::new();
        for i in 0..count {
            let tick = Instant::now();
            let t = Instant::now();
            let crop = crop_bottom.map(|f| {
                let h = (f64::from(full_h) * f).round() as u32;
                Crop { x: 0, y: full_h - h, width: full_w, height: h, reference_width: full_w, reference_height: full_h }
            });
            let frame = match backend.capture(&CaptureRequest { source_id: source.id.clone(), crop }) {
                Ok(f) => f,
                Err(e) => {
                    eprintln!("capture: {} {}", e.code, e.message);
                    break;
                }
            };
            let capture_ms = t.elapsed().as_secs_f64() * 1000.0;
            let t = Instant::now();
            // As the app sends it: RGB, default PNG settings.
            let (fw, fh) = (frame.info.width, frame.info.height);
            let mut rgb = Vec::with_capacity((fw * fh * 3) as usize);
            for y in 0..fh as usize {
                let row = &frame.pixels[y * frame.info.stride..y * frame.info.stride + fw as usize * 4];
                for px in row.chunks_exact(4) {
                    rgb.extend_from_slice(&px[..3]);
                }
            }
            let mut png_bytes = Vec::new();
            {
                let mut enc = png::Encoder::new(&mut png_bytes, fw, fh);
                enc.set_color(png::ColorType::Rgb);
                enc.set_depth(png::BitDepth::Eight);
                let mut writer = enc.write_header().unwrap();
                writer.write_image_data(&rgb).unwrap();
            }
            let encode_ms = t.elapsed().as_secs_f64() * 1000.0;
            let request = format!("{{\"png\":\"{}\"}}", b64(&png_bytes));
            let cpu0 = cpu_ms(worker);
            let t = Instant::now();
            writeln!(stdin, "{request}").unwrap();
            stdin.flush().unwrap();
            line.clear();
            stdout.read_line(&mut line).unwrap();
            let ocr_ms = t.elapsed().as_secs_f64() * 1000.0;
            let worker_cpu = cpu_ms(worker) - cpu0;
            let value: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
            let groups = value["ocr"]["groups"].as_array().cloned().unwrap_or_default();
            let text: Vec<String> =
                groups.iter().filter_map(|g| g["text"].as_str().map(String::from)).collect();
            let chars: usize = text.iter().map(|t| t.chars().count()).sum();
            println!(
                "{i},{capture_ms:.1},{encode_ms:.1},{ocr_ms:.1},{worker_cpu:.0},{},{fw},{fh},{},{chars}",
                png_bytes.len() / 1024,
                text.len()
            );
            if show_text && i == 0 {
                eprintln!("text: {}", text.join(" | "));
            }
            ocr_all.push(ocr_ms);
            let spent = tick.elapsed();
            if interval > spent {
                std::thread::sleep(interval - spent);
            }
        }
        end(w, &format!("reads@{}ms", interval.as_millis()), ocr_all.len());
        println!(
            "OCR {label}: p50 {:.0} p95 {:.0} ms over {}",
            pct(&mut ocr_all.clone(), 0.5),
            pct(&mut ocr_all.clone(), 0.95),
            ocr_all.len()
        );
        stop.store(true, Ordering::Relaxed);
        let _ = probe.join();
        let _ = child.kill();
        let _ = child.wait();
        let _ = unsafe { CloseHandle(game) };
    }
}

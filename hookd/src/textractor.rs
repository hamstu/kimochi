//! The fallback engine: drives TextractorCLI over its UTF-16 stdin/stdout. Commands are
//! `attach -P<pid>`, `detach -P<pid>` and `<hookcode> -P<pid>`; each output line is
//! `[handle:pid:addr:ctx:ctx2:name:hookcode] text` (see `protocol::parse_textractor_line`).
//! Textractor has one CLI per bitness, `x86\TextractorCLI.exe` and `x64\TextractorCLI.exe`.
use crate::protocol::{emit, parse_textractor_line, thread_event, Thread};
use serde_json::json;
use std::collections::HashSet;
use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

struct Cli {
    _child: Child,
    stdin: ChildStdin,
}

pub struct Textractor {
    dir: PathBuf,
    clis: [Option<Cli>; 2],
    seen: Arc<Mutex<HashSet<Thread>>>,
    bits_of: std::collections::HashMap<u32, u32>,
}

impl Textractor {
    pub fn new(dir: &Path) -> Result<Self, String> {
        if !dir.join("x64").join("TextractorCLI.exe").is_file() && !dir.join("x86").join("TextractorCLI.exe").is_file()
        {
            return Err(format!("no TextractorCLI.exe under {}", dir.display()));
        }
        Ok(Textractor {
            dir: dir.to_path_buf(),
            clis: [None, None],
            seen: Default::default(),
            bits_of: Default::default(),
        })
    }

    fn cli(&mut self, bits: u32) -> Result<&mut Cli, String> {
        let slot = usize::from(bits != 32);
        if self.clis[slot].is_none() {
            let exe = self.dir.join(if bits == 32 { "x86" } else { "x64" }).join("TextractorCLI.exe");
            let mut child = Command::new(&exe)
                .current_dir(exe.parent().unwrap_or(&self.dir))
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("{}: {e}", exe.display()))?;
            let stdout = child.stdout.take().ok_or("no stdout")?;
            let stdin = child.stdin.take().ok_or("no stdin")?;
            let seen = self.seen.clone();
            std::thread::spawn(move || read_output(stdout, seen));
            self.clis[slot] = Some(Cli { _child: child, stdin });
        }
        Ok(self.clis[slot].as_mut().expect("just set"))
    }

    fn send(&mut self, bits: u32, line: &str) -> Result<(), String> {
        let cli = self.cli(bits)?;
        let bytes: Vec<u8> = format!("{line}\n").encode_utf16().flat_map(u16::to_le_bytes).collect();
        cli.stdin.write_all(&bytes).and_then(|_| cli.stdin.flush()).map_err(|e| e.to_string())
    }

    pub fn attach(&mut self, pid: u32, bits: u32) -> Result<(), String> {
        self.bits_of.insert(pid, bits);
        self.send(bits, &format!("attach -P{pid}"))?;
        emit("attached", json!({ "pid": pid, "bits": bits }));
        Ok(())
    }
    pub fn detach(&mut self, pid: u32) -> Result<(), String> {
        let bits = self.bits_of.remove(&pid).unwrap_or(64);
        self.send(bits, &format!("detach -P{pid}"))
    }
    pub fn insert(&mut self, pid: u32, code: &str) -> Result<(), String> {
        let bits = *self.bits_of.get(&pid).unwrap_or(&64);
        self.send(bits, &format!("{code} -P{pid}"))
    }
}

/// Decodes the CLI's UTF-16LE stream into lines. A line without a thread header continues the
/// previous sentence (Textractor prints a multi-line sentence as it is).
fn read_output(mut stdout: impl Read, seen: Arc<Mutex<HashSet<Thread>>>) {
    let mut pending: Vec<u16> = Vec::new();
    let mut odd: Option<u8> = None;
    let mut buf = [0u8; 4096];
    let mut current: Option<(Thread, String)> = None;
    let flush = |current: &mut Option<(Thread, String)>| {
        if let Some((thread, text)) = current.take() {
            emit("text", json!({ "key": thread.key(), "pid": thread.pid, "text": text }));
        }
    };
    loop {
        let n = match stdout.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let mut bytes = buf[..n].to_vec();
        if let Some(b) = odd.take() {
            bytes.insert(0, b);
        }
        if bytes.len() % 2 == 1 {
            odd = bytes.pop();
        }
        pending.extend(bytes.as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)));
        while let Some(end) = pending.iter().position(|&c| c == u16::from(b'\n')) {
            let line: Vec<u16> = pending.drain(..=end).collect();
            let line = String::from_utf16_lossy(&line)
                .trim_end_matches(['\r', '\n'])
                .trim_start_matches('\u{feff}')
                .to_string();
            match parse_textractor_line(&line) {
                Some(parsed) => {
                    flush(&mut current);
                    let new = seen.lock().map(|mut s| s.insert(parsed.thread)).unwrap_or(false);
                    if new {
                        thread_event("thread", &parsed.thread, &parsed.hookcode, &parsed.name);
                    }
                    current = Some((parsed.thread, parsed.text));
                }
                None if line.starts_with('[') || current.is_none() => {
                    flush(&mut current);
                    if !line.trim().is_empty() {
                        emit("info", json!({ "level": "console", "text": line }));
                    }
                }
                None => {
                    if let Some((_, text)) = current.as_mut() {
                        text.push('\n');
                        text.push_str(&line);
                    }
                }
            }
        }
        // A sentence is complete when the CLI pauses; it writes each one in a single burst.
        if pending.is_empty() {
            flush(&mut current);
        }
    }
    flush(&mut current);
    emit("info", json!({ "level": "warning", "text": "TextractorCLI exited" }));
}

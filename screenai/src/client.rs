//! Kimochi's side of the pipe: start the worker, wait for it to load the library, send frames.
//!
//! A worker that crashes, hangs or talks nonsense costs one failed scan: the caller drops it and
//! starts another on the next one. Nothing the library does can take Kimochi down with it.
use crate::wire::{self, Ready, Reply, Request};
use std::{
    collections::VecDeque,
    io::{BufRead, BufReader},
    path::Path,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

/// The last lines the worker printed to stderr, for an error message when it fails.
type Tail = Arc<Mutex<VecDeque<String>>>;
const TAIL_LINES: usize = 12;

pub struct Worker {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
    replies: mpsc::Receiver<std::io::Result<Reply>>,
    tail: Tail,
    pub ready: Ready,
}

impl Drop for Worker {
    fn drop(&mut self) {
        let mut child = self.child.lock().unwrap_or_else(|p| p.into_inner());
        let _ = child.kill();
        let _ = child.wait();
    }
}

impl Worker {
    /// Start `program` on the component in `dir` and wait up to `startup` for it to load the
    /// library and its models. `configure` adjusts the command (Windows creation flags, say).
    pub fn start(
        program: &Path,
        dir: &Path,
        startup: Duration,
        configure: impl FnOnce(&mut Command),
    ) -> Result<Self, String> {
        let mut command = Command::new(program);
        command
            .arg(dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        configure(&mut command);
        let mut child = command
            .spawn()
            .map_err(|e| format!("could not start the Screen AI worker: {e}"))?;
        let stdin = child.stdin.take().ok_or("the Screen AI worker has no stdin")?;
        let stdout = child.stdout.take().ok_or("the Screen AI worker has no stdout")?;
        let stderr = child.stderr.take().ok_or("the Screen AI worker has no stderr")?;
        let tail: Tail = Arc::default();
        let lines = tail.clone();
        std::thread::Builder::new()
            .name("screenai-stderr".into())
            .spawn(move || {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    eprintln!("[screenai] {line}");
                    let mut tail = lines.lock().unwrap_or_else(|p| p.into_inner());
                    if tail.len() == TAIL_LINES {
                        tail.pop_front();
                    }
                    tail.push_back(line);
                }
            })
            .map_err(|e| e.to_string())?;
        let (send, replies) = mpsc::channel();
        std::thread::Builder::new()
            .name("screenai-replies".into())
            .spawn(move || {
                let mut stdout = BufReader::with_capacity(1 << 16, stdout);
                loop {
                    let reply = wire::read_reply(&mut stdout);
                    let failed = reply.is_err();
                    if send.send(reply).is_err() || failed {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let child = Arc::new(Mutex::new(child));
        let ready = match wait(&replies, &child, &tail, startup, "load")? {
            Reply::Ready(ready) => ready,
            Reply::Error(message) => return Err(message),
            Reply::Result(_) => return Err("the Screen AI worker answered before it was ready".into()),
        };
        Ok(Self { child, stdin, replies, tail, ready })
    }

    /// Read one RGBA frame given as its rows (each `request.width * 4` bytes) and return the
    /// library's serialized `VisualAnnotation`. A failure leaves this worker unusable when it
    /// crashed or timed out; the caller should drop it on any `Err`.
    pub fn recognize<'a>(
        &mut self,
        request: Request,
        rows: impl IntoIterator<Item = &'a [u8]>,
        timeout: Duration,
    ) -> Result<Vec<u8>, String> {
        // A worker that stops reading would block this write forever: a watchdog kills it at the
        // deadline, which closes the pipe and turns the write into an error.
        let (done, deadline) = mpsc::channel::<()>();
        let child = self.child.clone();
        std::thread::Builder::new()
            .name("screenai-watchdog".into())
            .spawn(move || {
                if deadline.recv_timeout(timeout) == Err(mpsc::RecvTimeoutError::Timeout) {
                    let _ = child.lock().unwrap_or_else(|p| p.into_inner()).kill();
                }
            })
            .map_err(|e| e.to_string())?;
        let written = request.write(&mut self.stdin, rows);
        let reply = match written {
            Ok(()) => wait(&self.replies, &self.child, &self.tail, timeout, "read the image"),
            Err(e) => Err(died(&self.child, &self.tail).unwrap_or_else(|| format!("could not send the image: {e}"))),
        };
        let _ = done.send(());
        match reply? {
            Reply::Result(bytes) => Ok(bytes),
            Reply::Error(message) => Err(message),
            Reply::Ready(_) => Err("the Screen AI worker restarted unexpectedly".into()),
        }
    }
}

/// The worker's next reply, or why there is none.
fn wait(
    replies: &mpsc::Receiver<std::io::Result<Reply>>,
    child: &Mutex<Child>,
    tail: &Tail,
    timeout: Duration,
    doing: &str,
) -> Result<Reply, String> {
    match replies.recv_timeout(timeout) {
        Ok(Ok(reply)) => Ok(reply),
        Ok(Err(_)) | Err(mpsc::RecvTimeoutError::Disconnected) => Err(died(child, tail)
            .unwrap_or_else(|| "the Screen AI worker stopped answering".into())),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let _ = child.lock().unwrap_or_else(|p| p.into_inner()).kill();
            Err(format!("Screen AI did not {doing} within {} s", timeout.as_secs()))
        }
    }
}

/// "the Screen AI worker crashed (…)" when it has exited, with the last thing it printed.
fn died(child: &Mutex<Child>, tail: &Tail) -> Option<String> {
    let mut child = child.lock().unwrap_or_else(|p| p.into_inner());
    // The pipe closes a moment before the exit status is ready.
    let mut status = None;
    for _ in 0..20 {
        if let Ok(Some(s)) = child.try_wait() {
            status = Some(s);
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let status = status?;
    let last = tail.lock().unwrap_or_else(|p| p.into_inner()).back().cloned();
    let how = if status.success() { "exited".to_string() } else { format!("crashed ({status})") };
    Some(match last {
        Some(line) => format!("the Screen AI worker {how}: {line}"),
        None => format!("the Screen AI worker {how}"),
    })
}

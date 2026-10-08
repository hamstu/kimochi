//! Local OneOCR, hosted in a separate native worker. No server or Python.
use base64::Engine as _;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    os::windows::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{mpsc, LazyLock, Mutex, OnceLock},
    time::Duration,
};
use tauri::Manager;

const FILES: [&str; 3] = ["oneocr.dll", "oneocr.onemodel", "onnxruntime.dll"];
const NO_WINDOW: u32 = 0x08000000;
static SNIPPING: OnceLock<Option<PathBuf>> = OnceLock::new();
static WORKER: LazyLock<Mutex<Option<Worker>>> = LazyLock::new(|| Mutex::new(None));

struct Assets {
    root: PathBuf,
    worker: PathBuf,
}

fn custom_root() -> PathBuf {
    PathBuf::from(std::env::var_os("USERPROFILE").unwrap_or_default()).join(".config/oneocr")
}
fn snipping_root() -> Option<PathBuf> {
    SNIPPING.get_or_init(|| {
        let powershell = PathBuf::from(std::env::var_os("SystemRoot")?).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let output = Command::new(powershell).args(["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-AppxPackage Microsoft.ScreenSketch | Select-Object -First 1 -ExpandProperty InstallLocation"])
            .creation_flags(NO_WINDOW).output().ok()?;
        if !output.status.success() { return None; }
        let path = String::from_utf8(output.stdout).ok()?;
        let path = path.trim().trim_start_matches('\u{feff}');
        (!path.is_empty()).then(|| PathBuf::from(path).join("SnippingTool"))
    }).clone()
}

/// PE machine selects the worker; an ARM64 Snipping Tool cannot load into x64.
fn architecture(file: &Path) -> Result<&'static str, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(file).map_err(|e| e.to_string())?;
    let mut header = [0u8; 64];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    if &header[..2] != b"MZ" {
        return Err("OneOCR DLL is not a PE file".into());
    }
    let offset = u32::from_le_bytes(header[60..64].try_into().unwrap());
    file.seek(SeekFrom::Start(u64::from(offset)))
        .map_err(|e| e.to_string())?;
    let mut pe = [0u8; 6];
    file.read_exact(&mut pe).map_err(|e| e.to_string())?;
    if &pe[..4] != b"PE\0\0" {
        return Err("OneOCR DLL has no PE signature".into());
    }
    match u16::from_le_bytes([pe[4], pe[5]]) {
        0x8664 => Ok("x64"),
        0xaa64 => Ok("arm64"),
        machine => Err(format!(
            "OneOCR DLL architecture 0x{machine:04X} is unsupported; use x64 or ARM64 files"
        )),
    }
}
fn assets(app: &tauri::AppHandle) -> Result<Assets, String> {
    let custom = custom_root();
    // A complete user-supplied set wins. Never mix DLLs/models from two versions.
    let root = if FILES.iter().all(|name| custom.join(name).is_file()) {
        custom.clone()
    } else {
        snipping_root().filter(|root| FILES.iter().all(|name| root.join(name).is_file())).ok_or_else(|| {
        format!("OneOCR needs oneocr.dll, oneocr.onemodel and onnxruntime.dll from Snipping Tool. Put all three matching files in {}. On Windows 11, installing or updating Snipping Tool also supplies them.", custom.display())
    })?
    };
    let arch = architecture(&root.join("oneocr.dll"))?;
    if architecture(&root.join("onnxruntime.dll"))? != arch {
        return Err("OneOCR DLLs have different architectures; use all three files from the same Snipping Tool package".into());
    }
    let name = format!("kimochi-oneocr-{arch}.exe");
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("oneocr")
        .join(&name);
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources/oneocr")
        .join(&name);
    let worker = [bundled, development]
        .into_iter()
        .find(|p| p.is_file())
        .ok_or_else(|| {
            format!("OneOCR {arch} helper is missing. Rebuild Kimochi with npm run bundle.")
        })?;
    Ok(Assets { root, worker })
}

pub fn capability(app: &tauri::AppHandle) -> Value {
    match assets(app) {
        Ok(assets) => json!({"available":true,"selectable":true,"runtimePath":assets.root}),
        Err(reason) => json!({"available":false,"selectable":true,"reason":reason}),
    }
}

struct Worker {
    child: Child,
    stdin: ChildStdin,
    replies: mpsc::Receiver<Result<Value, String>>,
    root: PathBuf,
}
impl Drop for Worker {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Worker {
    fn start(assets: &Assets, runtime: &Path) -> Result<Self, String> {
        let mut child = Command::new(&assets.worker)
            .arg(runtime)
            .creation_flags(NO_WINDOW)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("OneOCR worker: {e}"))?;
        let stdin = child.stdin.take().ok_or("OneOCR worker has no stdin")?;
        let stdout = child.stdout.take().ok_or("OneOCR worker has no stdout")?;
        let (send, replies) = mpsc::channel();
        let mut worker = Self {
            child,
            stdin,
            replies,
            root: assets.root.clone(),
        };
        std::thread::Builder::new()
            .name("oneocr-output".into())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let value = line.map_err(|e| e.to_string()).and_then(|line| {
                        serde_json::from_str(&line)
                            .map_err(|e| format!("OneOCR worker protocol: {e}: {line}"))
                    });
                    if send.send(value).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let reply = worker.receive(Duration::from_secs(60))?;
        if reply["ready"] != true {
            return Err("OneOCR worker did not become ready".into());
        }
        Ok(worker)
    }
    fn receive(&mut self, timeout: Duration) -> Result<Value, String> {
        let value = self
            .replies
            .recv_timeout(timeout)
            .map_err(|e| format!("OneOCR worker did not respond: {e}"))??;
        if let Some(error) = value["error"].as_str() {
            return Err(error.into());
        }
        Ok(value)
    }
    fn recognize(&mut self, png: &[u8]) -> Result<Value, String> {
        let request = json!({"png":base64::engine::general_purpose::STANDARD.encode(png)});
        writeln!(self.stdin, "{request}")
            .and_then(|()| self.stdin.flush())
            .map_err(|e| format!("OneOCR worker input: {e}"))?;
        let reply = self.receive(Duration::from_secs(45))?;
        reply
            .get("ocr")
            .cloned()
            .ok_or_else(|| "OneOCR worker returned no OCR result".into())
    }
}
pub fn recognize(app: &tauri::AppHandle, png: &[u8]) -> Result<Value, String> {
    let assets = assets(app)?;
    let mut slot = WORKER.lock().unwrap_or_else(|p| p.into_inner());
    if slot
        .as_ref()
        .is_some_and(|worker| worker.root != assets.root)
    {
        *slot = None;
    }
    if slot.is_none() {
        // Unpackaged processes cannot LoadLibrary from WindowsApps (error 5).
        // Copy only a complete matching installed package, into a versioned
        // private cache. User-supplied Windows 10 files already live outside it.
        let runtime = if assets.root == custom_root() {
            assets.root.clone()
        } else {
            let package = assets
                .root
                .parent()
                .and_then(Path::file_name)
                .ok_or("OneOCR Snipping Tool package has no name")?;
            let cache = app
                .path()
                .app_local_data_dir()
                .map_err(|e| e.to_string())?
                .join("oneocr")
                .join(package);
            std::fs::create_dir_all(&cache).map_err(|e| format!("OneOCR cache: {e}"))?;
            for name in FILES {
                let source = assets.root.join(name);
                let target = cache.join(name);
                let size = std::fs::metadata(&source).map_err(|e| e.to_string())?.len();
                if std::fs::metadata(&target).is_ok_and(|m| m.len() == size) {
                    continue;
                }
                let staged = cache.join(format!("{name}.tmp"));
                std::fs::copy(&source, &staged)
                    .map_err(|e| format!("OneOCR copy {}: {e}", source.display()))?;
                if target.exists() {
                    std::fs::remove_file(&target).map_err(|e| e.to_string())?;
                }
                std::fs::rename(staged, target).map_err(|e| e.to_string())?;
            }
            cache
        };
        *slot = Some(Worker::start(&assets, &runtime)?);
    }
    let result = slot.as_mut().unwrap().recognize(png);
    // A timed-out/crashed worker must never contaminate the next frame's reply.
    if result.is_err() {
        *slot = None;
    }
    result
}

//! The Screen AI worker: loads Google's library from the component directory given as the only
//! argument, then reads frames from stdin and answers on stdout (`kimochi_screenai::wire`).
//!
//! The library's interface is the one Chromium's `services/screen_ai/screen_ai_library_wrapper_impl.cc`
//! resolves: plain C exports, with the model files handed over through two callbacks rather than
//! read from disk by the library, and the image passed as a Skia `SkBitmap`, whose memory layout
//! is reproduced below. clv-locro's notes (CHROME_SCREEN_AI_DLL.md) and owocr's `ChromeScreenAI`
//! describe the same interface; docs/SCREENAI_NOTES.md in Kimochi records what was checked here.
use kimochi_screenai::wire::{self, Ready, Request};
use libloading::{Library, Symbol};
use std::{
    ffi::{c_char, c_void, CStr},
    fs::File,
    io::{self, BufReader, Read, Write},
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

/// `SkImageInfo` as the library was compiled: colour space, colour type, alpha type, then the
/// dimensions (`SkColorInfo` before `SkISize`).
#[repr(C)]
struct SkImageInfo {
    color_space: *const c_void,
    color_type: i32,
    alpha_type: i32,
    width: i32,
    height: i32,
}

#[repr(C)]
struct SkPixmap {
    pixels: *const c_void,
    row_bytes: usize,
    info: SkImageInfo,
}

#[repr(C)]
struct SkBitmap {
    pixel_ref: *const c_void,
    pixmap: SkPixmap,
    flags: u32,
}

/// A stand-in `SkPixelRef`. `SkBitmap::isNull()` and `drawsNothing()` test only that the pixel
/// ref is set; pixels are read through the pixmap. The vtable is all null and the reference
/// count starts far from zero, so a copy of the bitmap inside the library (ref, then unref)
/// never reaches the virtual destructor. Some library versions also accept a null pixel ref
/// (owocr passes one); this works for both.
#[repr(C)]
struct FakePixelRef {
    vtable: *const [usize; 32],
    ref_count: i32,
    _pad: i32,
    width: i32,
    height: i32,
    pixels: *const c_void,
    row_bytes: usize,
    _spare: [u8; 64],
}

static NULL_VTABLE: [usize; 32] = [0; 32];

const RGBA_8888: i32 = 4;
const OPAQUE: i32 = 1;

type GetVersion = unsafe extern "C" fn(*mut u32, *mut u32);
type SizeCallback = extern "C" fn(*const c_char) -> u32;
type ContentCallback = extern "C" fn(*const c_char, u32, *mut c_char);
type SetFileContentFunctions = unsafe extern "C" fn(SizeCallback, ContentCallback);
type InitOcr = unsafe extern "C" fn() -> bool;
type SetLightMode = unsafe extern "C" fn(bool);
type GetMaxDimension = unsafe extern "C" fn() -> u32;
type PerformOcr = unsafe extern "C" fn(*const SkBitmap, *mut u32) -> *mut c_char;
type FreeArray = unsafe extern "C" fn(*mut c_char);
type EnableDebug = unsafe extern "C" fn();

/// The component directory the library's model paths are relative to.
static ROOT: OnceLock<PathBuf> = OnceLock::new();

/// A path the library asked for, inside the component directory; nothing absolute or `..`.
fn model_path(requested: *const c_char) -> Option<PathBuf> {
    if requested.is_null() {
        return None;
    }
    let relative = unsafe { CStr::from_ptr(requested) }.to_str().ok()?;
    let relative = Path::new(relative);
    if !relative.components().all(|c| matches!(c, Component::Normal(_) | Component::CurDir)) {
        return None;
    }
    Some(ROOT.get()?.join(relative))
}

extern "C" fn file_size(requested: *const c_char) -> u32 {
    model_path(requested)
        .and_then(|path| std::fs::metadata(path).ok())
        .and_then(|m| u32::try_from(m.len()).ok())
        .unwrap_or(0)
}

extern "C" fn file_content(requested: *const c_char, size: u32, buffer: *mut c_char) {
    if buffer.is_null() || size == 0 {
        return;
    }
    let out = unsafe { std::slice::from_raw_parts_mut(buffer.cast::<u8>(), size as usize) };
    let read = model_path(requested).and_then(|path| File::open(path).ok()).map(|mut file| file.read_exact(out));
    if !matches!(read, Some(Ok(()))) {
        out.fill(0);
    }
}

/// The library also exists on Linux in Chrome's own process, which provides one symbol it
/// imports. A no-op here is what Chrome's is outside its own logging setup.
#[cfg(target_os = "linux")]
#[no_mangle]
pub extern "C" fn _ZN12threadlogger21EnableThreadedLoggingEi(_: i32) {}

/// The protocol's stdout, taken before the library loads; the process's stdout then points at
/// stderr, so anything the library prints cannot corrupt a reply.
fn protocol_output() -> io::Result<File> {
    #[cfg(unix)]
    unsafe {
        use std::os::fd::FromRawFd;
        let fd = libc::dup(1);
        if fd < 0 || libc::dup2(2, 1) < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(File::from_raw_fd(fd))
    }
    #[cfg(windows)]
    unsafe {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::System::Console::{GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
        let out = GetStdHandle(STD_OUTPUT_HANDLE);
        if out.is_null() || SetStdHandle(STD_OUTPUT_HANDLE, GetStdHandle(STD_ERROR_HANDLE)) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(File::from_raw_handle(out))
    }
}

struct Engine {
    _library: Library,
    perform: PerformOcr,
    free: FreeArray,
    light: SetLightMode,
    light_on: bool,
    ready: Ready,
}

fn symbol<T: Copy>(library: &Library, name: &str) -> Result<T, String> {
    unsafe { library.get::<T>(name.as_bytes()) }
        .map(|s: Symbol<T>| *s)
        .map_err(|e| format!("Screen AI library has no {name}: {e}"))
}

impl Engine {
    fn load(dir: &Path) -> Result<Self, String> {
        let name = kimochi_screenai::locate::library_name(std::env::consts::OS);
        let path = dir.join(name);
        let library = unsafe { Library::new(&path) }.map_err(|e| format!("could not load {}: {e}", path.display()))?;
        let version: GetVersion = symbol(&library, "GetLibraryVersion")?;
        let set_files: SetFileContentFunctions = symbol(&library, "SetFileContentFunctions")?;
        let init: InitOcr = symbol(&library, "InitOCRUsingCallback")?;
        let light: SetLightMode = symbol(&library, "SetOCRLightMode")?;
        let max: GetMaxDimension = symbol(&library, "GetMaxImageDimension")?;
        let perform: PerformOcr = symbol(&library, "PerformOCR")?;
        let free: FreeArray = symbol(&library, "FreeLibraryAllocatedCharArray")?;
        let (mut major, mut minor) = (0u32, 0u32);
        unsafe {
            version(&mut major, &mut minor);
            if std::env::var_os("KIMOCHI_SCREENAI_DEBUG").is_some() {
                if let Ok(debug) = symbol::<EnableDebug>(&library, "EnableDebugMode") {
                    debug();
                }
            }
            set_files(file_size, file_content);
            if !init() {
                return Err(format!("Screen AI {major}.{minor} could not load its models from {}", dir.display()));
            }
            light(false);
        }
        let max_dimension = unsafe { max() };
        Ok(Self {
            _library: library,
            perform,
            free,
            light,
            light_on: false,
            ready: Ready { major, minor, max_dimension },
        })
    }

    fn recognize(&mut self, request: Request, pixels: &[u8]) -> Result<Vec<u8>, String> {
        let (width, height) = (request.width, request.height);
        if width > self.ready.max_dimension || height > self.ready.max_dimension {
            return Err(format!(
                "image {width}×{height} is larger than Screen AI reads ({} px)",
                self.ready.max_dimension
            ));
        }
        let light = request.flags & wire::FLAG_LIGHT != 0;
        if light != self.light_on {
            unsafe { (self.light)(light) };
            self.light_on = light;
        }
        let row_bytes = width as usize * 4;
        let pixel_ref = FakePixelRef {
            vtable: &NULL_VTABLE,
            ref_count: 1 << 24,
            _pad: 0,
            width: width as i32,
            height: height as i32,
            pixels: pixels.as_ptr().cast(),
            row_bytes,
            _spare: [0; 64],
        };
        let bitmap = SkBitmap {
            pixel_ref: (&pixel_ref as *const FakePixelRef).cast(),
            pixmap: SkPixmap {
                pixels: pixels.as_ptr().cast(),
                row_bytes,
                info: SkImageInfo {
                    color_space: std::ptr::null(),
                    color_type: RGBA_8888,
                    alpha_type: OPAQUE,
                    width: width as i32,
                    height: height as i32,
                },
            },
            flags: 0,
        };
        let mut length = 0u32;
        let result = unsafe { (self.perform)(&bitmap, &mut length) };
        if result.is_null() {
            return Err("Screen AI could not read this image".into());
        }
        let bytes = unsafe { std::slice::from_raw_parts(result.cast::<u8>(), length as usize) }.to_vec();
        unsafe { (self.free)(result) };
        Ok(bytes)
    }
}

fn run() -> Result<(), String> {
    let dir =
        std::env::args_os().nth(1).map(PathBuf::from).ok_or("usage: kimochi-screenai-worker <component directory>")?;
    let mut out = protocol_output().map_err(|e| format!("could not set up the pipe: {e}"))?;
    let _ = ROOT.set(dir.clone());
    let mut engine = match Engine::load(&dir) {
        Ok(engine) => engine,
        Err(message) => {
            let _ = wire::write_reply(&mut out, wire::ERROR, message.as_bytes());
            return Err(message);
        }
    };
    wire::write_reply(&mut out, wire::READY, &wire::ready_payload(&engine.ready)).map_err(|e| e.to_string())?;
    let mut input = BufReader::with_capacity(1 << 20, io::stdin().lock());
    let mut pixels = Vec::new();
    while let Some(request) = Request::read(&mut input).map_err(|e| e.to_string())? {
        if request.width == 0 || request.height == 0 {
            break;
        }
        let size = request.pixel_bytes()?;
        pixels.resize(size, 0);
        input.read_exact(&mut pixels).map_err(|e| e.to_string())?;
        let (kind, payload) = match engine.recognize(request, &pixels) {
            Ok(bytes) => (wire::RESULT, bytes),
            Err(message) => (wire::ERROR, message.into_bytes()),
        };
        wire::write_reply(&mut out, kind, &payload).map_err(|e| e.to_string())?;
    }
    out.flush().map_err(|e| e.to_string())
}

fn main() {
    if let Err(message) = run() {
        eprintln!("{message}");
        std::process::exit(1);
    }
}

//! Native MeikiOCR sessions are loaded lazily and reused by both scan paths.
//!
//! Three users of the runtime live here: the manual scan (`recognize`, one shared
//! engine in `MeikiState`), the automatic-scan observer (`text_observer.rs`, its
//! own engine on its own worker), and the availability probe (`availability`,
//! a background check). When MeikiOCR is selected, the check warms the manual engine;
//! otherwise its temporary engine is dropped. The observer has its own sessions.
use crate::engine_probe::{self, Loaded, Probe, Verified};
use crate::model_store;
use meikiocr::{Backend, BackendInfo, Config, MeikiOcr, ModelPaths, OcrOptions, TextLine};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex, OnceLock,
    },
};
use tauri::Manager;

#[derive(Default)]
pub struct MeikiState(Mutex<Option<MeikiOcr>>);

/// The bundled native runtime's root (`<root>/runtime/<library>`): the resource
/// directory, then the development fallback. The runtime always ships with the app;
/// only the models are downloaded (`model_store`).
fn runtime_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("meikiocr");
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/meikiocr");
    [bundled, development]
        .into_iter()
        .find(|root| runtime_library(root).is_file())
        .ok_or_else(|| RUNTIME_MISSING.to_string())
}

/// Where the runtime and the models were found.
pub(crate) struct Assets {
    runtime: PathBuf,
    models: PathBuf,
}

/// The models directory, or why MeikiOCR cannot scan yet ("Downloading model… 32%").
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn models_ready(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    model_store::models_dir(app, model_store::Engine::Meiki)
}

/// Drop the manual scan's engine so its model files can be deleted.
pub fn unload(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<MeikiState>() {
        *state.0.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

/// The ONNX Runtime library this OS loads, inside the asset root.
fn runtime_library(root: &Path) -> PathBuf {
    let name = if cfg!(target_os = "macos") {
        "libonnxruntime.dylib"
    } else if cfg!(target_os = "windows") {
        "onnxruntime.dll"
    } else {
        "libonnxruntime.so"
    };
    root.join("runtime").join(name)
}

/// The native files `scripts/prepare-meikiocr.mjs` stages for this OS, for diagnostics.
/// On Windows the DirectML flavour stages all three; a CPU-only staging omits DirectML.
const RUNTIME_FILES: &[&str] = if cfg!(target_os = "windows") {
    &[
        "onnxruntime.dll",
        "onnxruntime_providers_shared.dll",
        "DirectML.dll",
    ]
} else if cfg!(target_os = "macos") {
    &["libonnxruntime.dylib"]
} else {
    &["libonnxruntime.so"]
};

/// Which staged runtime files are present, as "name: present|missing" lines.
fn runtime_files(runtime_dir: &Path) -> Vec<String> {
    RUNTIME_FILES
        .iter()
        .map(|name| {
            let state = if runtime_dir.join(name).is_file() {
                "present"
            } else {
                "missing"
            };
            format!("{name}: {state}")
        })
        .collect()
}

const RUNTIME_MISSING: &str =
    "MeikiOCR native runtime is missing. Rebuild Kimochi with npm run bundle.";

/// Whether the models and native runtime are present, without loading either.
/// The models are checked first, so an engine waiting for its download says so.
fn presence(app: &tauri::AppHandle) -> Result<Assets, String> {
    let models = model_store::models_dir(app, model_store::Engine::Meiki)?;
    Ok(Assets {
        runtime: runtime_root(app)?,
        models,
    })
}

/// Whether the native runtime is bundled, whatever the state of the models.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn runtime_available(app: &tauri::AppHandle) -> Result<(), String> {
    runtime_root(app).map(|_| ())
}

static PROBE: LazyLock<Arc<Probe>> = LazyLock::new(Default::default);

/// Whether MeikiOCR can run here, for `platform_capabilities`.
///
/// Missing files are reported at once. Present files are reported available
/// until the first call's background probe (`engine_probe`) has actually loaded
/// the runtime and built the sessions; from then on this is the verified answer.
/// Nothing here blocks: the probe never runs on the caller's thread.
pub fn availability(app: &tauri::AppHandle) -> (bool, Option<String>) {
    let assets = match presence(app) {
        Ok(assets) => assets,
        Err(reason) => return (false, Some(reason)),
    };
    // On macOS the Core ML path is proven and the sessions are built on first scan, as
    // they always were; building them at startup just to verify would add a CPU and
    // memory burst that the release app never had. The probe is for the platforms whose
    // runtime (DirectML, the VC++ runtime, CUDA) is still being established.
    if cfg!(target_os = "macos") {
        return (true, None);
    }
    let probe_app = app.clone();
    let probe = move || {
        let describe = |engine: &MeikiOcr| {
            let info = engine.backend_info();
            let mut diagnostics = RUNTIME_DIAGNOSTICS.get().cloned().unwrap_or_default();
            diagnostics.extend(
                info.fallback_reasons
                    .iter()
                    .map(|r| format!("fallback: {r}")),
            );
            Loaded {
                accelerator: accelerator(info.selected),
                diagnostics,
            }
        };
        // Verification already pays for loading the sessions. For the selected engine,
        // keep that work: the first scan must not build an identical engine again.
        // The same lock as scans/unload also prevents duplicate concurrent loads.
        let selected = probe_app.try_state::<crate::state::Shared>()
            .is_some_and(|service| matches!(
                service.settings.get_or::<String>("ocrMode", String::new()).as_str(),
                "meikiocr" | "local"
            ));
        if selected {
            if let Some(state) = probe_app.try_state::<MeikiState>() {
                let mut slot = state.0.lock()
                    .map_err(|_| "MeikiOCR worker unavailable".to_string())?;
                if slot.is_none() {
                    *slot = Some(load_engine(&assets)?);
                }
                return Ok(describe(slot.as_ref().ok_or("MeikiOCR initialization failed")?));
            }
        }
        // Unselected engines do not keep a resident copy merely for capabilities.
        let engine = load_engine(&assets)?;
        Ok(describe(&engine))
    };
    match PROBE.verified_or_start("meikiocr", engine_probe::PROBE_TIMEOUT, probe) {
        Some(verified) => (verified.available, verified.reason),
        None => (true, None),
    }
}

/// The verified verdict once the probe has finished: accelerator and diagnostics.
// TODO(integrator): surface `accelerator` in `ocrEngines.meikiocr` instead of the OS table's guess.
#[allow(dead_code)]
pub fn verification() -> Option<Verified> {
    PROBE.verified()
}

/// Run `hook` whenever the probe records a verdict, so capabilities can be re-announced.
pub fn on_verified(hook: impl Fn() + Send + Sync + 'static) {
    PROBE.on_verified(hook);
}

/// The accelerator name `platform_capabilities` uses for a Meiki backend.
pub(crate) fn accelerator(backend: Backend) -> &'static str {
    match backend {
        Backend::CoreMl => "coreml",
        Backend::DirectMl => "directml",
        Backend::Cuda => "cuda",
        Backend::Cpu | Backend::Auto => "cpu",
    }
}

/// Which runtime files were present when the runtime was initialised.
static RUNTIME_DIAGNOSTICS: OnceLock<Vec<String>> = OnceLock::new();

fn initialize_runtime(root: &Path) -> Result<(), String> {
    static INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();
    INITIALIZED
        .get_or_init(|| {
            let library = runtime_library(root);
            // The directory of the library itself: `<resources>/meikiocr/runtime`.
            let runtime_dir = library.parent().unwrap_or(root);
            let files = runtime_files(runtime_dir);
            let _ = RUNTIME_DIAGNOSTICS.set(files.clone());
            if !library.is_file() {
                return Err(RUNTIME_MISSING.into());
            }
            #[cfg(target_os = "windows")]
            windows_dll::prepare(runtime_dir, &library)
                .map_err(|e| format!("{e} (runtime files: {})", files.join(", ")))?;
            // ort's dynamic loader panics for absent dependencies or incompatible APIs.
            // Turn those deployment failures into a scan error instead of poisoning the engine lock.
            std::panic::catch_unwind(|| ort::init_from(library.to_string_lossy()).commit())
                .map_err(|_| {
                    format!(
                        "MeikiOCR could not load ONNX Runtime or its native dependencies (runtime files: {}).",
                        files.join(", ")
                    )
                })?
                .map(|_| ())
                .map_err(|e| format!("MeikiOCR runtime: {e}"))
        })
        .clone()
}

/// The bundled ONNX Runtime, initialised for the whole process, for another model that runs on
/// it (sentence audio's speech detection).
pub(crate) fn onnx_runtime(app: &tauri::AppHandle) -> Result<(), String> {
    initialize_runtime(&runtime_root(app)?)
}

/// The runtime and models, when both are present.
/// For an engine owned elsewhere (the observer), which loads it with `load_engine`.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn engine_root(app: &tauri::AppHandle) -> Result<Assets, String> {
    presence(app)
}

/// Initialise the runtime and build a fresh engine (three sessions).
///
/// Panics from the runtime are caught: a provider that panics during session
/// creation is a deployment failure, reported like any other.
pub(crate) fn load_engine(assets: &Assets) -> Result<MeikiOcr, String> {
    initialize_runtime(&assets.runtime)?;
    let models = ModelPaths::from_dir(&assets.models);
    let config = Config {
        backend: if DIRECTML_REFUSED.load(Ordering::Relaxed) { Backend::Cpu } else { Backend::Auto },
        ..Config::default()
    };
    let engine = engine_probe::guarded(|| {
        MeikiOcr::with_config(models, config).map_err(|e| format!("MeikiOCR models: {e}"))
    })?;
    if refused_directml(engine.backend_info()) {
        DIRECTML_REFUSED.store(true, Ordering::Relaxed);
    }
    Ok(engine)
}

/// Set once an adapter accepts DirectML sessions but fails the crate's first-inference probe
/// (seen on Windows on ARM under virtualisation). Every engine after that asks for CPU
/// directly, instead of repeating the failed run and its ONNX Runtime error on stderr.
static DIRECTML_REFUSED: AtomicBool = AtomicBool::new(false);

fn refused_directml(info: &BackendInfo) -> bool {
    info.selected == Backend::Cpu && info.fallback_reasons.iter().any(|r| r.starts_with("DirectMl"))
}

/// One DirectML inference at a time across every engine in the process.
///
/// The manual scan and the observer own separate engines so a slow scan cannot
/// starve observer ticks, but two concurrent DirectML runs on one adapter contend
/// for the same command queue and are where driver hangs have been reported. CPU
/// and CoreML runs are not serialised. Neither holder takes another lock while
/// holding this one, so it cannot deadlock with `MeikiState`.
static DIRECTML_RUN: Mutex<()> = Mutex::new(());

/// Detection plus recognition on one image, in image pixel coordinates.
pub(crate) fn infer(
    engine: &mut MeikiOcr,
    image: &image::RgbImage,
) -> Result<Vec<TextLine>, String> {
    let _serial = (engine.backend_info().selected == Backend::DirectMl)
        .then(|| DIRECTML_RUN.lock().unwrap_or_else(|p| p.into_inner()));
    engine_probe::guarded(|| {
        engine
            .ocr(image, OcrOptions::default())
            .map_err(|e| format!("MeikiOCR inference: {e}"))
    })
}

pub fn recognize(app: &tauri::AppHandle, image: &crate::state::Image) -> Result<Value, String> {
    let image = image.rgb().map_err(|e| format!("MeikiOCR {e}"))?;
    let assets = presence(app).map_err(|reason| format!("MeikiOCR is not ready: {reason}"))?;
    initialize_runtime(&assets.runtime)?;
    let state = app.state::<MeikiState>();
    let mut engine = state
        .0
        .lock()
        .map_err(|_| "MeikiOCR worker unavailable".to_string())?;
    if engine.is_none() {
        *engine = Some(load_engine(&assets)?);
    }
    let engine = engine.as_mut().ok_or("MeikiOCR initialization failed")?;
    let lines = infer(engine, &image)?;
    let mut result = annotations(&lines);
    result["backend"] = serde_json::to_value(engine.backend_info()).map_err(|e| e.to_string())?;
    Ok(result)
}

/// Secure DLL loading for the Windows ONNX Runtime.
///
/// `onnxruntime.dll` (DirectML build) imports `DirectML.dll` and loads
/// `onnxruntime_providers_shared.dll`; all three are staged in
/// `<resources>/meikiocr/runtime`. Windows does not search a loaded DLL's own
/// directory for its imports, so that directory is added with `AddDllDirectory`
/// after switching the process to the safe search set with
/// `SetDefaultDllDirectories(DEFAULT_DIRS | USER_DIRS)` (application dir, user
/// dirs, System32; no CWD, no PATH). `SetDllDirectoryW` is deliberately not
/// used: it disables safe search mode process-wide and is inherited by children.
///
/// `DirectML.dll` is then preloaded by absolute path so the provider binds to the
/// version we ship rather than the older copy some Windows builds keep in
/// System32, and `onnxruntime.dll` is preloaded too so a missing dependency is
/// diagnosed here instead of surfacing as a panic inside `ort`'s loader.
///
/// Visual C++ runtime strategy (CROSS_PLATFORM_PLAN.md Phase 4): the installer is
/// per-user and needs no admin, so we never run the elevated redist installer.
/// `onnxruntime.dll` links the MSVC runtime dynamically; it resolves either from
/// app-local `vcruntime140*.dll`/`msvcp140.dll` beside the exe (searched first as
/// the application directory, if packaging ever stages them) or from an installed
/// redist in System32. When neither exists, MeikiOCR is reported unavailable
/// with the reason and download link below; there is no CPU fallback for this
/// case because the CPU path lives in the same `onnxruntime.dll`. Manga OCR
/// (Candle, no ONNX Runtime) and the cloud engines keep working.
#[cfg(target_os = "windows")]
mod windows_dll {
    use std::path::Path;
    use windows::core::HSTRING;
    use windows::Win32::Foundation::{ERROR_BAD_EXE_FORMAT, ERROR_MOD_NOT_FOUND};
    use windows::Win32::System::LibraryLoader::{
        AddDllDirectory, LoadLibraryExW, SetDefaultDllDirectories,
        LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_USER_DIRS,
    };

    const VC_REDIST_URL: &str = if cfg!(target_arch = "aarch64") {
        "https://aka.ms/vs/17/release/vc_redist.arm64.exe"
    } else {
        "https://aka.ms/vs/17/release/vc_redist.x64.exe"
    };

    /// The MSVC runtime DLLs ONNX Runtime imports.
    const VC_RUNTIME: &[&str] = if cfg!(target_arch = "x86_64") {
        &["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"]
    } else {
        &["vcruntime140.dll", "msvcp140.dll"]
    };

    fn load(path: &HSTRING) -> windows::core::Result<()> {
        // Handles are intentionally kept: ORT loads these same modules next.
        unsafe { LoadLibraryExW(path, None, LOAD_LIBRARY_SEARCH_DEFAULT_DIRS) }.map(|_| ())
    }

    pub fn prepare(runtime_dir: &Path, library: &Path) -> Result<(), String> {
        unsafe {
            SetDefaultDllDirectories(
                LOAD_LIBRARY_SEARCH_DEFAULT_DIRS | LOAD_LIBRARY_SEARCH_USER_DIRS,
            )
        }
        .map_err(|e| format!("MeikiOCR could not enable safe DLL search: {e}"))?;
        let cookie = unsafe { AddDllDirectory(&HSTRING::from(runtime_dir)) };
        if cookie.is_null() {
            return Err(format!(
                "MeikiOCR could not add {} to the DLL search path: {}",
                runtime_dir.display(),
                windows::core::Error::from_win32()
            ));
        }
        let directml = runtime_dir.join("DirectML.dll");
        if directml.is_file() {
            // A failure here is not fatal: the DirectML provider then fails to
            // register and Meiki falls back to CPU, which the probe reports.
            let _ = load(&HSTRING::from(directml.as_path()));
        }
        match load(&HSTRING::from(library)) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == ERROR_MOD_NOT_FOUND.to_hresult() => {
                let missing: Vec<_> = VC_RUNTIME
                    .iter()
                    .filter(|name| load(&HSTRING::from(**name)).is_err())
                    .copied()
                    .collect();
                if missing.is_empty() {
                    Err(format!(
                        "MeikiOCR could not load onnxruntime.dll: one of its DLL dependencies is missing ({e})."
                    ))
                } else {
                    Err(format!(
                        "Microsoft Visual C++ Redistributable is missing ({}), so MeikiOCR cannot load. Install it from {VC_REDIST_URL} and restart Kimochi.",
                        missing.join(", ")
                    ))
                }
            }
            Err(e) if e.code() == ERROR_BAD_EXE_FORMAT.to_hresult() => {
                Err("MeikiOCR's onnxruntime.dll was built for a different CPU architecture.".into())
            }
            Err(e) => Err(format!("MeikiOCR could not load onnxruntime.dll: {e}")),
        }
    }
}

/// The overlay's cloud-compatible annotation contract uses capture pixel coordinates.
fn annotations(lines: &[TextLine]) -> Value {
    let nonempty: Vec<_> = lines.iter().filter(|l| !l.text.is_empty()).collect();
    let text = nonempty
        .iter()
        .map(|l| l.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let mut annotations: Vec<_> = nonempty
        .iter()
        .map(|line| {
            let [x1, y1, x2, y2] = line.bbox;
            json!({
                "description": line.text,
                "boundingPoly": {"vertices": [
                    {"x": x1, "y": y1}, {"x": x2, "y": y1},
                    {"x": x2, "y": y2}, {"x": x1, "y": y2}
                ]},
                "isVertical": line.is_vertical,
                "characters": line.characters,
                "confidence": line.detection_confidence,
            })
        })
        .collect();
    // Annotation zero is the aggregate in the existing cloud contract. The UI
    // strips it before filtering/rendering; omitting it would drop the first line.
    if !nonempty.is_empty() {
        let left = nonempty.iter().map(|l| l.bbox[0]).min().unwrap_or(0);
        let top = nonempty.iter().map(|l| l.bbox[1]).min().unwrap_or(0);
        let right = nonempty.iter().map(|l| l.bbox[2]).max().unwrap_or(0);
        let bottom = nonempty.iter().map(|l| l.bbox[3]).max().unwrap_or(0);
        annotations.insert(
            0,
            json!({"description": text, "boundingPoly": {"vertices": [
                {"x":left,"y":top}, {"x":right,"y":top},
                {"x":right,"y":bottom}, {"x":left,"y":bottom}
            ]}}),
        );
    }
    json!({"fullText": text, "textAnnotations": annotations, "engine": "meikiocr"})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_a_failed_directml_probe_pins_later_engines_to_cpu() {
        let info = |selected, reasons: &[&str]| BackendInfo {
            requested: Backend::Auto,
            selected,
            fallback_reasons: reasons.iter().map(|r| r.to_string()).collect(),
        };
        let probe = "DirectMl: model contract: DirectML detection inference probe failed";
        assert!(refused_directml(&info(Backend::Cpu, &[probe])));
        assert!(!refused_directml(&info(Backend::Cpu, &[])));
        assert!(!refused_directml(&info(Backend::DirectMl, &[])));
        assert!(!refused_directml(&info(Backend::Cpu, &["Cuda: provider unavailable"])));
    }
    #[test]
    #[ignore = "requires prepared assets and MEIKIOCR_TEST_IMAGE"]
    fn bundled_runtime_recognizes_example() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/meikiocr");
        initialize_runtime(&root).unwrap();
        let mut engine = MeikiOcr::new(ModelPaths::from_dir(root.join("models"))).unwrap();
        let lines = engine
            .ocr_file(
                std::env::var("MEIKIOCR_TEST_IMAGE").unwrap(),
                OcrOptions::default(),
            )
            .unwrap();
        assert!(lines.iter().any(|l| l.text.contains("ナルホド")));
        let value = annotations(&lines);
        assert_eq!(
            value["textAnnotations"].as_array().unwrap().len(),
            lines.iter().filter(|l| !l.text.is_empty()).count() + 1
        );
        println!("Bundled OCR: {:?}", engine.backend_info());
    }

    #[test]
    #[ignore = "manual CPU/accelerator comparison; requires MEIKIOCR_TEST_IMAGE and MEIKIOCR_MODEL_DIR"]
    fn fixture_backend_diagnostics() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/meikiocr");
        initialize_runtime(&root).unwrap();
        let source = image::open(std::env::var("MEIKIOCR_TEST_IMAGE").unwrap()).unwrap().to_rgb8();
        for backend in [Backend::Auto, Backend::Cpu] {
            let mut engine = MeikiOcr::with_config(
                ModelPaths::from_dir(std::env::var("MEIKIOCR_MODEL_DIR").unwrap()),
                Config { backend, ..Config::default() },
            ).unwrap();
            for image in [source.clone(), image::imageops::resize(&source, source.width() * 2, source.height() * 2, image::imageops::FilterType::Triangle)] {
                let detections = engine.detect(&image, 0.0).unwrap();
                let lines = infer(&mut engine, &image).unwrap();
                println!("backend={:?} size={}x{} candidates={} above_default={} max_score={} lines={}",
                    engine.backend_info(), image.width(), image.height(), detections.len(),
                    detections.iter().filter(|item| item.confidence > 0.5).count(),
                    detections.iter().map(|item| item.confidence).fold(0.0_f32, f32::max), lines.len());
            }
        }
    }

    #[test]
    fn overlay_contract_preserves_text_and_capture_coordinates() {
        let line = TextLine {
            text: "日本語".into(),
            bbox: [10, 20, 90, 40],
            detection_confidence: Some(0.9),
            characters: vec![],
            is_vertical: false,
        };
        let empty = TextLine {
            text: String::new(),
            ..line.clone()
        };
        let result = annotations(&[line, empty]);
        assert_eq!(result["fullText"], "日本語");
        assert_eq!(result["textAnnotations"].as_array().unwrap().len(), 2);
        assert_eq!(
            result["textAnnotations"][1]["boundingPoly"]["vertices"][2],
            json!({"x":90,"y":40})
        );
    }
}

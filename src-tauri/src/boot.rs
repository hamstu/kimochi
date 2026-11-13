//! Startup timing: milliseconds from process start to each step of the main window's way onto the
//! screen. Native marks are taken here; the main window's page adds its own (navigation, first
//! paint, first render, ready) and reports them once with `report` as `{check: "startup"}`, which
//! `report` completes with these marks. One line per launch in `evidence.jsonl`, read by
//! `scripts/startup-bench.mjs`. `KIMOCHI_BOOT_TRACE=1` also prints each mark as it happens.
use serde_json::{json, Map, Value};
use std::sync::{Mutex, OnceLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

static START: OnceLock<(Instant, u64)> = OnceLock::new();
static MARKS: Mutex<Vec<(&'static str, u64)>> = Mutex::new(Vec::new());
type Job = Box<dyn FnOnce(&tauri::AppHandle) + Send>;
static AFTER_READY: Mutex<Option<(tauri::AppHandle, Job)>> = Mutex::new(None);

/// How long the deferred startup waits for the main window to say it is ready: the first window
/// may be the welcome guide, which never does, or a page that failed to load.
const READY_FALLBACK: std::time::Duration = std::time::Duration::from_millis(2500);

/// Runs `job` once the main window has painted its content (its `startup` report, [`main_ready`]),
/// or after [`READY_FALLBACK`], whichever is first. From any thread; `job` runs on a worker.
pub fn after_main_ready(app: &tauri::AppHandle, job: impl FnOnce(&tauri::AppHandle) + Send + 'static) {
    *AFTER_READY.lock().unwrap_or_else(|p| p.into_inner()) = Some((app.clone(), Box::new(job)));
    std::thread::spawn(|| {
        std::thread::sleep(READY_FALLBACK);
        run_after_ready("deferred-by-timeout", std::time::Duration::ZERO);
    });
}

/// How long after the main window's ready report the rest starts: its first frame fades over the
/// content (`hideBootFrame` in frontend/entries/boot.ts), which building windows would stutter.
const AFTER_READY_SETTLE: std::time::Duration = std::time::Duration::from_millis(300);

/// The main window reported that it shows its content.
pub fn main_ready() {
    run_after_ready("deferred-by-ready", AFTER_READY_SETTLE);
}

fn run_after_ready(reason: &'static str, settle: std::time::Duration) {
    let Some((app, job)) = AFTER_READY.lock().unwrap_or_else(|p| p.into_inner()).take() else { return };
    mark(reason);
    // Never inside the caller (the `report` command): the job queues its own main-thread turn.
    std::thread::spawn(move || {
        std::thread::sleep(settle);
        job(&app)
    });
}

/// Called first thing in `main`.
pub fn start() {
    START.get_or_init(|| {
        let epoch = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        (Instant::now(), epoch)
    });
}

/// Wall-clock milliseconds at process start, so a page can measure itself against it.
pub fn epoch_ms() -> u64 {
    START.get().map_or(0, |(_, epoch)| *epoch)
}

/// Records `name` once, at the time since process start. Later marks of the same name are ignored.
pub fn mark(name: &'static str) {
    let Some((start, _)) = START.get() else { return };
    let ms = start.elapsed().as_millis() as u64;
    let mut marks = MARKS.lock().unwrap_or_else(|p| p.into_inner());
    if marks.iter().any(|(n, _)| *n == name) {
        return;
    }
    marks.push((name, ms));
    if std::env::var_os("KIMOCHI_BOOT_TRACE").is_some() {
        eprintln!("kimochi boot: {ms:>6} ms  {name}");
    }
}

/// The native marks so far, in order.
pub fn marks() -> Value {
    let marks = MARKS.lock().unwrap_or_else(|p| p.into_inner());
    Value::Object(marks.iter().map(|(n, ms)| (n.to_string(), json!(ms))).collect::<Map<_, _>>())
}

/// Completes a page's `startup` report with the native marks and the build kind.
pub fn complete(value: &mut Value) {
    if value.get("check").and_then(Value::as_str) != Some("startup") {
        return;
    }
    main_ready();
    if let Some(object) = value.as_object_mut() {
        object.insert("native".into(), marks());
        object.insert("build".into(), json!(if cfg!(debug_assertions) { "debug" } else { "release" }));
        object.insert("dev".into(), json!(cfg!(dev)));
        // Restarted with the Gaming Mode launcher's settings (platform/linux/gaming_launch.rs).
        if std::env::var("KIMOCHI_GAMING_RELAUNCHED").as_deref() == Ok("1") {
            object.insert("gamingModeRelaunch".into(), json!(true));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marks_once_and_completes_only_startup_reports() {
        start();
        mark("test-a");
        mark("test-a");
        let all = marks();
        assert!(all.get("test-a").is_some());
        let mut other = json!({ "check": "other" });
        complete(&mut other);
        assert!(other.get("native").is_none());
        let mut startup = json!({ "check": "startup" });
        complete(&mut startup);
        assert!(startup["native"].get("test-a").is_some());
        assert!(startup["build"].is_string());
    }
}

//! "Installed" is not "runnable": a one-shot, background check that a local OCR
//! engine actually loads on this machine.
//!
//! A bundled ONNX Runtime can be present and still fail to load (a missing
//! `DirectML.dll`, no Visual C++ runtime, a driver that refuses the provider), and
//! a model can be present and still fail to build. Presence is what
//! `platform_capabilities` could report cheaply at startup; this upgrades that
//! answer to a verified one, without ever blocking the caller:
//!
//!  - the first `verified_or_start` returns `None` and starts the probe on its own
//!    thread, so the caller keeps reporting the presence-based answer;
//!  - the probe runs the engine's loader on a second, sacrificial thread with a
//!    timeout and `catch_unwind`, because ORT's dynamic loader panics on some
//!    deployment failures and a wedged driver may never return;
//!  - the verdict is cached for the process and the `on_verified` hook fires, so
//!    the app can announce the corrected capabilities.
//!
//! A load that outlives the timeout is reported unavailable, and if it later
//! finishes the late verdict replaces that one and the hook fires again.
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{mpsc, Arc, Mutex, OnceLock},
    time::Duration,
};

/// How long a first load may take before the engine is reported unavailable.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// The verified answer for one engine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified {
    pub available: bool,
    /// The accelerator the engine actually selected ("coreml", "directml", "cpu", ...).
    pub accelerator: Option<&'static str>,
    /// Why it is unavailable; `None` when available.
    pub reason: Option<String>,
    /// Supporting facts for diagnostics: runtime files found, provider fallbacks.
    pub diagnostics: Vec<String>,
}

/// What a successful load reports.
#[derive(Debug, Clone, Default)]
pub struct Loaded {
    pub accelerator: &'static str,
    pub diagnostics: Vec<String>,
}

#[derive(Default)]
enum State {
    #[default]
    Idle,
    Running,
    Done(Verified),
}

type Hook = Box<dyn Fn() + Send + Sync>;

#[derive(Default)]
pub struct Probe {
    state: Mutex<State>,
    hook: OnceLock<Hook>,
}

impl Probe {
    /// Called (on the probe thread) whenever a verdict is recorded.
    /// Only the first registration wins; the app registers once at setup.
    pub fn on_verified(&self, hook: impl Fn() + Send + Sync + 'static) {
        let _ = self.hook.set(Box::new(hook));
    }

    /// The verified answer, if there is one yet. Never blocks on the engine:
    /// the first call starts the probe and returns `None`.
    pub fn verified_or_start(
        self: &Arc<Self>,
        name: &'static str,
        timeout: Duration,
        load: impl FnOnce() -> Result<Loaded, String> + Send + 'static,
    ) -> Option<Verified> {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        match &*state {
            State::Done(verified) => return Some(verified.clone()),
            State::Running => return None,
            State::Idle => *state = State::Running,
        }
        drop(state);
        let probe = self.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("kimochi-{name}-probe"))
            .spawn(move || probe.run(name, timeout, load));
        if let Err(e) = spawned {
            self.record(unavailable(format!(
                "{name}: could not start its probe: {e}"
            )));
        }
        None
    }

    /// The cached verdict, without starting anything.
    pub fn verified(&self) -> Option<Verified> {
        match &*self.state.lock().unwrap_or_else(|p| p.into_inner()) {
            State::Done(verified) => Some(verified.clone()),
            _ => None,
        }
    }

    fn run(
        &self,
        name: &'static str,
        timeout: Duration,
        load: impl FnOnce() -> Result<Loaded, String> + Send + 'static,
    ) {
        let (send, receive) = mpsc::channel();
        let spawned = std::thread::Builder::new()
            .name(format!("kimochi-{name}-load"))
            .spawn(move || {
                let _ = send.send(guarded(load));
            });
        if let Err(e) = spawned {
            self.record(unavailable(format!(
                "{name}: could not start its loader: {e}"
            )));
            return;
        }
        match receive.recv_timeout(timeout) {
            Ok(result) => self.record(verdict(result)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.record(unavailable(format!(
                    "{name} did not finish loading within {} s; its runtime or GPU driver may be stalled.",
                    timeout.as_secs()
                )));
                // A slow first load (a cold model compile) is still an answer.
                if let Ok(result) = receive.recv() {
                    self.record(verdict(result));
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => self.record(unavailable(format!(
                "{name}: its loader exited without an answer"
            ))),
        }
    }

    fn record(&self, verified: Verified) {
        *self.state.lock().unwrap_or_else(|p| p.into_inner()) = State::Done(verified);
        if let Some(hook) = self.hook.get() {
            hook();
        }
    }
}

/// How a caught panic's message starts, so callers can tell it from an ordinary error.
pub const PANIC_PREFIX: &str = "the engine panicked";

/// Run engine code, turning a panic into an error message that starts with `PANIC_PREFIX`.
pub fn guarded<T>(f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    catch_unwind(AssertUnwindSafe(f)).unwrap_or_else(|panic| {
        let message = panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .unwrap_or("unknown panic");
        Err(format!("{PANIC_PREFIX}: {message}"))
    })
}

fn verdict(result: Result<Loaded, String>) -> Verified {
    match result {
        Ok(loaded) => Verified {
            available: true,
            accelerator: Some(loaded.accelerator),
            reason: None,
            diagnostics: loaded.diagnostics,
        },
        Err(reason) => unavailable(reason),
    }
}

fn unavailable(reason: String) -> Verified {
    Verified {
        available: false,
        accelerator: None,
        reason: Some(reason),
        diagnostics: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;

    fn wait_for(probe: &Probe, mut until: impl FnMut(&Verified) -> bool) -> Verified {
        let start = Instant::now();
        loop {
            if let Some(v) = probe.verified() {
                if until(&v) {
                    return v;
                }
            }
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "probe never finished"
            );
            std::thread::yield_now();
        }
    }

    #[test]
    fn first_call_starts_and_later_calls_get_the_cached_verdict() {
        let probe = Arc::new(Probe::default());
        let loads = Arc::new(AtomicUsize::new(0));
        let hooks = Arc::new(AtomicUsize::new(0));
        let h = hooks.clone();
        probe.on_verified(move || {
            h.fetch_add(1, Ordering::SeqCst);
        });
        let l = loads.clone();
        let load = move || {
            l.fetch_add(1, Ordering::SeqCst);
            Ok(Loaded {
                accelerator: "cpu",
                diagnostics: vec!["runtime: x".into()],
            })
        };
        assert!(probe
            .verified_or_start("test", Duration::from_secs(5), load)
            .is_none());
        let verified = wait_for(&probe, |_| true);
        assert!(verified.available);
        assert_eq!(verified.accelerator, Some("cpu"));
        // Later calls never run the loader again.
        let again =
            probe.verified_or_start("test", Duration::from_secs(5), || panic!("must not reload"));
        assert_eq!(again, Some(verified));
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        assert_eq!(hooks.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_panicking_loader_is_reported_unavailable_with_its_message() {
        let probe = Arc::new(Probe::default());
        probe.verified_or_start("test", Duration::from_secs(5), || {
            panic!("missing DirectML.dll")
        });
        let verified = wait_for(&probe, |_| true);
        assert!(!verified.available);
        assert!(verified.reason.unwrap().contains("missing DirectML.dll"));
    }

    #[test]
    fn a_slow_load_times_out_and_a_late_answer_replaces_the_timeout() {
        let probe = Arc::new(Probe::default());
        let (release, gate) = mpsc::channel::<()>();
        probe.verified_or_start("test", Duration::from_millis(20), move || {
            let _ = gate.recv();
            Ok(Loaded {
                accelerator: "directml",
                diagnostics: vec![],
            })
        });
        let timed_out = wait_for(&probe, |_| true);
        assert!(!timed_out.available);
        assert!(timed_out.reason.unwrap().contains("did not finish loading"));
        release.send(()).unwrap();
        let late = wait_for(&probe, |v| v.available);
        assert_eq!(late.accelerator, Some("directml"));
    }
}

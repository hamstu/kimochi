//! Apple Live Text, through the private VisionKitCore API.
//!
//! This is `VKCImageAnalyzer`, the engine behind selecting text in a screenshot
//! in Preview. It is not the public Vision framework's `VNRecognizeTextRequest`,
//! and it is unpublished, which is the trade the user has explicitly accepted
//! here. No comparison of the two engines' Japanese accuracy was measured in this
//! work, so none is claimed.
//!
//! What the choice costs, stated plainly so it is not rediscovered later:
//!
//!  - **Private API.** `VKCImageAnalyzer` and `VKCImageAnalyzerRequest` are not in
//!    any SDK. Nothing here links against them; the framework is `dlopen`ed and
//!    every class and selector is looked up and probed at run time, so a macOS
//!    release that renames or removes them degrades to "observer unavailable"
//!    with a message, rather than failing to launch.
//!  - **macOS 13 and later.** Older systems report unsupported.
//!  - **Distribution.** Apple's review guidelines have long treated non-public
//!    API use as grounds for rejection, so an App Store build should not be
//!    assumed possible on this path without checking the policy that applies at
//!    the time. Direct distribution is unaffected. Not legal advice, and no
//!    current policy text was consulted for this note.
//!  - **Maintenance.** Each major macOS release needs this path re-checked. The
//!    seam it sits behind (`TextObserver`) exists so replacing it with a public
//!    or bundled engine is a new file, not a rewrite.
//!
//! Pixels go in directly. The frame's RGBA buffer is copied once into an
//! `NSBitmapImageRep` that owns it — no PNG encode, no `capture:` URL, no fetch
//! and no canvas, so nothing about reading a frame depends on that round trip.

use super::{join_lines, Observation, ObserverStatus, TextLine, TextObserver};
use crate::{CaptureError, Frame, Result};
use block2::{Block, RcBlock};
use objc2::rc::{autoreleasepool, Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject, Sel};
use objc2::{msg_send, sel, AllocAnyThread};
use objc2_app_kit::{NSBitmapFormat, NSBitmapImageRep, NSDeviceRGBColorSpace, NSImage, NSImageRep};
use objc2_foundation::{NSArray, NSRect, NSSize, NSString};
use std::ffi::{c_char, c_int, c_void, CStr};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

const FRAMEWORK: &[u8] =
    b"/System/Library/PrivateFrameworks/VisionKitCore.framework/VisionKitCore\0";
const RTLD_LAZY: c_int = 0x1;
/// `VKAnalysisTypeText`. Text only: we do not want subject lift or barcodes.
const ANALYSIS_TYPE_TEXT: usize = 1;

extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    /// Non-zero on the process's main thread.
    fn pthread_main_np() -> c_int;
}

// libdispatch, from libSystem. `dispatch_get_main_queue()` is a macro for the
// address of `_dispatch_main_q`, so only its address is needed here.
extern "C" {
    static _dispatch_main_q: u8;
    fn dispatch_async(queue: *const u8, block: *mut Block<dyn Fn()>);
}

/// Hand a block to the main queue.
///
/// Called from inside a main-queue callback, this is the whole ordering
/// guarantee: the main queue is serial, so a block submitted from within the
/// current item cannot run until that item has finished — after the completion
/// closure, after `block2`'s trampoline has unwound through `invoke`, and after
/// whatever VisionKit does with the block on the way out.
///
/// SAFETY: `dispatch_async` copies the block, which is documented public
/// behaviour, so the caller's reference may be dropped afterwards.
unsafe fn on_main_queue(work: impl Fn() + 'static) {
    let block = RcBlock::new(work);
    dispatch_async(&_dispatch_main_q as *const u8, RcBlock::as_ptr(&block));
}

type CFStringRef = *const c_void;
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopDefaultMode: CFStringRef;
    fn CFRunLoopRunInMode(mode: CFStringRef, seconds: f64, return_after_source_handled: u8) -> i32;
}

/// Where the completion block puts its answer.
///
/// Plain Rust data behind a mutex, deliberately: the block extracts everything it
/// needs from the analysis while it is still valid and stores strings and
/// numbers, so no Objective-C object is ever handed to another thread and a late
/// callback cannot touch anything that has been freed.
///
/// Two facts are recorded, not one, because they answer different questions and
/// become true at different moments:
///
///  - `answer` is the result, and is what the waiting thread is woken for.
///  - `returned` says the completion closure's body has run to its end. The
///    closure lives inside the block's own allocation, so freeing the block the
///    instant the answer appears would be freeing memory the closure is still
///    running in.
///
/// What `returned` does **not** prove, stated plainly because the distinction is
/// easy to lose: the closure's body finishing is not the same as the invocation
/// having returned. `block2`'s trampoline still has to unwind through the block's
/// `invoke` function, and VisionKit still has whatever it does with the block
/// afterwards. See `Outstanding::release` for why releasing is nonetheless sound,
/// and for the stronger guarantee available to anyone who wants one.
struct SlotState {
    answer: Option<std::result::Result<Vec<TextLine>, String>>,
    returned: bool,
    /// Set by a block the completion handed to the main queue, which therefore
    /// cannot run until the completion's own main-queue item has finished.
    acknowledged: bool,
    /// The completion did not arrive on the main thread, so the acknowledgement
    /// cannot be ordered and nothing may be released.
    off_main: bool,
}

struct Slot {
    state: Mutex<SlotState>,
    ready: Condvar,
}

impl Slot {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(SlotState {
                answer: None,
                returned: false,
                acknowledged: false,
                off_main: false,
            }),
            ready: Condvar::new(),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, SlotState> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn settled(&self) -> bool {
        self.lock().answer.is_some()
    }

    /// The completion closure's body has finished. Necessary for a release, and
    /// on its own not sufficient: see `acknowledged`.
    fn returned(&self) -> bool {
        self.lock().returned
    }

    /// The main queue has run an item submitted from inside the completion.
    ///
    /// This is what permits a release, and it is an ordering fact rather than an
    /// argument: a serial queue cannot start the acknowledgement until the item
    /// that submitted it — the completion, its trampoline and VisionKit's own
    /// handling — has finished.
    fn acknowledged(&self) -> bool {
        self.lock().acknowledged
    }

    fn acknowledge(&self) {
        let mut guard = self.lock();
        guard.acknowledged = true;
        self.ready.notify_all();
    }

    /// The completion arrived somewhere the acknowledgement cannot be ordered.
    fn off_main(&self) -> bool {
        self.lock().off_main
    }

    fn mark_off_main(&self) {
        let mut guard = self.lock();
        guard.off_main = true;
        self.ready.notify_all();
    }

    /// Sleep until `ready` is satisfied or the deadline passes.
    fn wait_for_flag(&self, deadline: Instant, ready: impl Fn(&SlotState) -> bool) {
        let mut guard = self.lock();
        while !ready(&guard) {
            let now = Instant::now();
            if now >= deadline {
                return;
            }
            let (next, timed_out) = self
                .ready
                .wait_timeout(guard, deadline - now)
                .unwrap_or_else(|e| e.into_inner());
            guard = next;
            if timed_out.timed_out() {
                return;
            }
        }
    }

    fn fill(&self, outcome: std::result::Result<Vec<TextLine>, String>) {
        let mut guard = self.lock();
        if guard.answer.is_none() {
            guard.answer = Some(outcome);
        }
        self.ready.notify_all();
    }

    fn mark_returned(&self) {
        let mut guard = self.lock();
        guard.returned = true;
        self.ready.notify_all();
    }

    fn take(&self) -> Option<std::result::Result<Vec<TextLine>, String>> {
        self.lock().answer.take()
    }

    /// Sleep until the completion arrives or the deadline passes.
    ///
    /// Used off the main thread, where the callback is delivered by somebody
    /// else's run loop and there is nothing useful for this thread to do.
    fn wait_until(&self, deadline: Instant) {
        let mut guard = self.lock();
        while guard.answer.is_none() {
            let now = Instant::now();
            if now >= deadline {
                return;
            }
            let (next, timed_out) = self
                .ready
                .wait_timeout(guard, deadline - now)
                .unwrap_or_else(|e| e.into_inner());
            guard = next;
            if timed_out.timed_out() {
                return;
            }
        }
    }
}

/// Marks the completion closure's body as finished, and asks the main queue to
/// say when the invocation around it has actually unwound.
///
/// Dropped last in the completion, so the acknowledgement is submitted after the
/// answer is stored. The submission itself is what orders reclamation: the main
/// queue is serial, so the acknowledgement block cannot run until the item that
/// submitted it has completed — the closure, `block2`'s trampoline, and anything
/// VisionKit does with the block on its way out.
///
/// If the completion did not arrive on the main thread, that ordering is not
/// available and the slot is marked instead. Nothing is ever released on that
/// path; the observer refuses further work and says why.
struct ReturnGuard(Arc<Slot>);

impl Drop for ReturnGuard {
    fn drop(&mut self) {
        let slot = self.0.clone();
        slot.mark_returned();
        // SAFETY: a libSystem call with no arguments.
        if unsafe { pthread_main_np() } == 0 {
            slot.mark_off_main();
            return;
        }
        // SAFETY: submitting an owned block to the main queue, which copies it.
        unsafe {
            on_main_queue(move || slot.acknowledge());
        }
    }
}

/// An analysis that has been started.
///
/// Holds everything the analysis could still touch: the request object and both
/// blocks. **Nothing here is ever released on a timer.** The only thing that
/// permits a release is `slot.returned()` — the completion closure having run to
/// its end. Elapsed time is evidence of nothing on an unpublished interface: a
/// request that has not called back may be queued, throttled, or waiting on a
/// resource, and releasing its memory or starting a second analysis beside it
/// would be a guess about someone else's implementation.
///
/// Blocks are kept deliberately. A callee that stores a block for asynchronous
/// use is expected to copy it, but "expected to" is not a guarantee worth taking
/// here, and holding our own reference costs one allocation.
struct Outstanding {
    slot: Arc<Slot>,
    request: *mut AnyObject,
    progress: *mut Block<dyn Fn(f64)>,
    completion: *mut Block<dyn Fn(*mut AnyObject, *mut AnyObject)>,
    /// The analyzer's own identifier for this analysis, for `cancelRequestID:`.
    id: i32,
    /// When this analysis was started, for reporting only. It is never a reason
    /// to release anything or to start anything.
    started_at: Instant,
    /// Whether it was cancelled after timing out.
    cancelled: bool,
}

// SAFETY: these pointers are only turned back into their owning Rust types and
// dropped, or passed to `cancelRequestID:`. Objective-C reference counting and
// block disposal are both thread-safe, and the observer itself is only ever used
// from one thread at a time.
unsafe impl Send for Outstanding {}

impl Outstanding {
    /// Let go of everything this analysis was using.
    ///
    /// SAFETY: the caller must have established `self.slot.acknowledged()`.
    ///
    /// That is an ordering fact, not an argument about timing or refcounts. The
    /// completion runs as a main-queue item and, as its last act, submits an
    /// acknowledgement block to that same queue. The main queue is serial, so the
    /// acknowledgement cannot begin until the item that submitted it has
    /// finished — which means the closure has returned, `block2`'s trampoline has
    /// unwound through `invoke`, and whatever VisionKit does with the block on the
    /// way out has happened too. Seeing `acknowledged` therefore establishes that
    /// nothing will touch this allocation again.
    ///
    /// `returned` alone is deliberately not enough: it is set from inside the
    /// closure, which is still executing in the block's own allocation.
    unsafe fn release(self) {
        debug_assert!(
            self.slot.acknowledged(),
            "released an analysis the main queue has not acknowledged"
        );
        drop(Retained::from_raw(self.request));
        drop(RcBlock::from_raw(self.progress));
        drop(RcBlock::from_raw(self.completion));
    }
}

/// One analyzer for the life of the observer.
///
/// Automatic scanning calls `observe` several times a second for hours, and a
/// timeout must not be able to leave a second analyzer behind. There is exactly
/// one, it is created on first use, and every analysis — including every retry
/// after a timeout — is started on it.
struct Analyzer(*mut AnyObject);

// SAFETY: as `Outstanding`. `VKCImageAnalyzer` has its own processing queue and
// is used from one thread at a time here.
unsafe impl Send for Analyzer {}

impl Drop for Analyzer {
    fn drop(&mut self) {
        // SAFETY: the pointer came from `Retained::into_raw` and is released once.
        unsafe { drop(Retained::from_raw(self.0)) };
    }
}

/// How long an unreturned analysis is tolerated before the observer declares
/// itself stalled.
///
/// This governs **reporting only**. It never releases memory and never permits a
/// second analysis: past this point the observer refuses to observe at all and
/// says a restart is needed, which is the honest answer when an unpublished API
/// has taken a request and not given it back.
const STALL_REPORT_AFTER: Duration = Duration::from_secs(30);

/// How long to give the main queue to run an acknowledgement that has been
/// submitted.
///
/// This waits for a fact, it does not assume one: if the acknowledgement does not
/// arrive, nothing is released and no further analysis is started. It exists only
/// so that a caller arriving one main-queue hop too early reports nothing at all
/// rather than a spurious "busy".
const ACK_WAIT: Duration = Duration::from_millis(250);

enum Availability {
    Untried,
    Ready,
    Missing(String),
    /// An analysis was started and never returned. Terminal for this observer.
    Stalled(String),
}

pub struct LiveTextObserver {
    availability: Availability,
    analyzer: Option<Analyzer>,
    outstanding: Option<Outstanding>,
    /// Counted so the caller can see that timeouts are happening at all.
    timeouts: u32,
}

impl Default for LiveTextObserver {
    fn default() -> Self {
        Self::new()
    }
}

impl LiveTextObserver {
    pub fn new() -> Self {
        Self {
            availability: Availability::Untried,
            analyzer: None,
            outstanding: None,
            timeouts: 0,
        }
    }

    /// Load the framework and prove every symbol we are about to send exists.
    ///
    /// Probing rather than assuming is the whole safety story for a private API:
    /// a renamed selector must be a message on screen, not a crash.
    fn ensure_available(&mut self) -> std::result::Result<(), String> {
        match &self.availability {
            Availability::Ready => return Ok(()),
            Availability::Missing(why) | Availability::Stalled(why) => return Err(why.clone()),
            Availability::Untried => {}
        }
        let result = probe();
        self.availability = match &result {
            Ok(()) => Availability::Ready,
            Err(why) => Availability::Missing(why.clone()),
        };
        result
    }

    /// The one analyzer, created on first use.
    fn analyzer(&mut self) -> Result<*mut AnyObject> {
        if let Some(existing) = &self.analyzer {
            return Ok(existing.0);
        }
        let class =
            class(c"VKCImageAnalyzer").map_err(|e| CaptureError::new("unsupported", e))?;
        // SAFETY: `new` on a class proved to exist.
        let analyzer: Retained<AnyObject> = unsafe { msg_send![class, new] };
        let pointer = Retained::into_raw(analyzer);
        self.analyzer = Some(Analyzer(pointer));
        Ok(pointer)
    }

    /// Settle the previous analysis, if there was one.
    ///
    /// The single rule: an analysis is released, and a new one permitted, **only**
    /// once the main queue has acknowledged that its completion finished. Nothing
    /// else counts — not a cancellation, not a timeout, and above all not elapsed
    /// time. However often the caller retries, exactly one analysis exists at a
    /// time.
    ///
    /// An analysis that is never acknowledged is therefore terminal. The observer
    /// says so and asks for a restart, rather than guessing that it must be
    /// finished by now and freeing memory somebody else may still hold.
    fn reap(&mut self) -> Result<()> {
        let Some(outstanding) = self.outstanding.take() else {
            return Ok(());
        };

        // The acknowledgement is a main-queue hop behind the answer, so a caller
        // arriving promptly may beat it. Waiting for the flag is not the same as
        // assuming it: nothing is released unless it actually arrives.
        if outstanding.slot.returned() && !outstanding.slot.acknowledged() {
            wait_for_acknowledgement(&outstanding.slot, Instant::now() + ACK_WAIT);
        }

        if outstanding.slot.acknowledged() {
            // SAFETY: the main queue ran an item submitted from inside the
            // completion, so the completion and its invocation have both
            // finished; nothing will read the request or either block again.
            unsafe { outstanding.release() };
            return Ok(());
        }

        if outstanding.slot.off_main() {
            // The delivery assumption this ordering rests on did not hold. There
            // is no safe way to reclaim, so everything is kept and the observer
            // stops rather than guessing.
            let why = format!(
                "Apple Live Text delivered analysis {} off the main thread, where the \
                 completion cannot be ordered against reclamation. Automatic scanning cannot \
                 continue safely on this observer; restart Kimochi to try again. Manual \
                 scanning still works.",
                outstanding.id
            );
            self.outstanding = Some(outstanding);
            self.availability = Availability::Stalled(why.clone());
            return Err(CaptureError::new("stalled", why));
        }

        let waited = outstanding.started_at.elapsed();
        let id = outstanding.id;
        let cancelled = outstanding.cancelled;
        let stalled = waited >= STALL_REPORT_AFTER;
        self.outstanding = Some(outstanding);

        if stalled {
            let why = format!(
                "Apple Live Text accepted analysis {id} {}s ago{} and has never finished. \
                 Automatic scanning cannot continue on this observer; restart Kimochi to try again. \
                 Manual scanning still works.",
                waited.as_secs(),
                if cancelled { ", was asked to cancel it," } else { "" }
            );
            self.availability = Availability::Stalled(why.clone());
            return Err(CaptureError::new("stalled", why));
        }
        Err(CaptureError::new(
            "busy",
            format!(
                "Apple Live Text has not finished analysis {id} yet ({}ms); not starting another.",
                waited.as_millis()
            ),
        ))
    }

    /// Stop a running analysis for real, not just stop waiting for it.
    fn cancel(&mut self, id: i32) {
        let Some(analyzer) = self.analyzer.as_ref().map(|a| a.0) else {
            return;
        };
        // SAFETY: `cancelRequestID:` was proved to exist in `probe`.
        unsafe {
            let _: () = msg_send![analyzer, cancelRequestID: id];
        }
    }
}

impl TextObserver for LiveTextObserver {
    fn status(&self) -> ObserverStatus {
        let detail = match &self.availability {
            Availability::Missing(why) => why.clone(),
            _ => "Apple Live Text (VisionKitCore, private API).".to_string(),
        };
        ObserverStatus {
            supported: !matches!(self.availability, Availability::Missing(_)),
            engine: "apple-live-text",
            minimum_os: "macOS 13",
            private_api: true,
            detail,
            timeouts: self.timeouts,
        }
    }

    fn observe(&mut self, frame: &Frame, timeout: Duration) -> Result<Observation> {
        self.ensure_available()
            .map_err(|why| CaptureError::new("unsupported", why))?;
        self.reap()?;

        let started = Instant::now();
        let slot = Slot::new();
        let analyzer = self.analyzer()?;
        let started_analysis = autoreleasepool(|_| -> Result<Started> {
            let image = image_from_frame(frame)?;
            start_analysis(analyzer, &image, slot.clone())
        })?;

        wait_for(&slot, started + timeout);

        let outcome = slot.take();
        // The analysis is retained either way, and released by the *next* call's
        // `reap`, once its completion closure's body has finished.
        //
        // Never released here, even when the answer has arrived: this thread is
        // woken from inside that closure, which is running in the block's own
        // allocation, so freeing it now would race its own invocation. Deferring
        // costs one retained request and two blocks until the next observation,
        // and is half of why the release in `Outstanding::release` is sound.
        let timed_out = outcome.is_none();
        if timed_out {
            // Stop the work, not just the waiting.
            self.timeouts += 1;
            self.cancel(started_analysis.id);
        }
        self.outstanding = Some(Outstanding {
            slot,
            request: started_analysis.request,
            progress: started_analysis.progress,
            completion: started_analysis.completion,
            id: started_analysis.id,
            started_at: started,
            cancelled: timed_out,
        });

        match outcome {
            Some(outcome) => {
                match outcome {
                    Ok(lines) => {
                        let lines = to_frame_pixels(lines, frame);
                        Ok(Observation {
                            engine: "apple-live-text",
                            text: join_lines(&lines),
                            lines,
                            duration_ms: crate::elapsed_ms(started),
                        })
                    }
                    Err(message) => Err(CaptureError::new("observer", message)),
                }
            }
            None => Err(CaptureError::new(
                "timeout",
                format!(
                    "Apple Live Text did not answer within {}ms; the analysis was cancelled and no other will start until it returns",
                    timeout.as_millis()
                ),
            )),
        }
    }

    /// Shut down, letting go only of what has provably finished.
    ///
    /// Cancellation is asked for, because it bounds real work. It is not treated
    /// as an answer: an analysis whose closure has not returned keeps everything
    /// it could still touch, **including the analyzer**, which is deliberately
    /// leaked rather than released. One abandoned analysis at shutdown is a far
    /// better outcome than freeing an object a private framework is still using,
    /// and it is bounded at one for the life of the observer.
    fn close(&mut self) {
        let analyzer = self.analyzer.take();
        if let Some(handle) = analyzer.as_ref() {
            // SAFETY: both selectors were proved to exist in `probe`.
            unsafe {
                if let Some(outstanding) = self.outstanding.as_ref() {
                    let _: () = msg_send![handle.0, cancelRequestID: outstanding.id];
                }
                let _: () = msg_send![handle.0, cancelAllRequests];
            }
        }

        // Shutting down is not a reason to reclaim early either. The
        // acknowledgement is given the same bounded chance to arrive as it is on
        // any other call, and if it does not, nothing is freed.
        if let Some(outstanding) = self.outstanding.as_ref() {
            if outstanding.slot.returned() && !outstanding.slot.acknowledged() {
                wait_for_acknowledgement(&outstanding.slot, Instant::now() + ACK_WAIT);
            }
        }
        match self.outstanding.take() {
            Some(outstanding) if outstanding.slot.acknowledged() => {
                // SAFETY: the main queue acknowledged the completion.
                unsafe { outstanding.release() };
            }
            Some(outstanding) => {
                // Still running, as far as anything can be known. Keep every
                // object it might touch alive for the rest of the process.
                std::mem::forget(outstanding);
                std::mem::forget(analyzer);
                return;
            }
            None => {}
        }
        drop(analyzer);
    }
}

impl Drop for LiveTextObserver {
    fn drop(&mut self) {
        self.close();
    }
}

/// Convert Live Text's normalised boxes into the frame's own pixels.
///
/// Live Text answers in fractions of the image, with a top-left origin — measured
/// rather than assumed, in `tests/livetext.rs`, which renders one line near the
/// top and one near the bottom and checks which has the smaller `y`. `TextLine`
/// promises pixels, because a tolerance in pixels is something a person can
/// reason about and a tolerance in fractions of an unknown image is not.
fn to_frame_pixels(lines: Vec<TextLine>, frame: &Frame) -> Vec<TextLine> {
    let width = f64::from(frame.info.width);
    let height = f64::from(frame.info.height);
    lines
        .into_iter()
        .map(|line| TextLine {
            text: line.text,
            x: line.x * width,
            y: line.y * height,
            width: line.width * width,
            height: line.height * height,
        })
        .collect()
}

/// Wait for the main queue to acknowledge a finished completion.
///
/// On the main thread the queue has to be driven, or the acknowledgement this is
/// waiting for is the very thing being blocked.
fn wait_for_acknowledgement(slot: &Slot, deadline: Instant) {
    // SAFETY: a libSystem call with no arguments and no side effects.
    if unsafe { pthread_main_np() } == 0 {
        slot.wait_for_flag(deadline, |state| state.acknowledged);
        return;
    }
    while !slot.acknowledged() {
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        let slice = (deadline - now).min(Duration::from_millis(5)).as_secs_f64();
        // SAFETY: a plain CoreFoundation call on the current thread's run loop.
        unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, slice.max(0.001), 1) };
    }
}

/// Wait for the completion, in whichever way this thread can.
///
/// **Live Text delivers its completion to the main run loop**, wherever the
/// analysis was started from. That single fact shapes how this is called:
///
///  - Off the main thread — which is where automatic scanning runs, on a capture
///    worker — there is nothing for this thread to do but sleep. It waits on the
///    condition variable and the main thread wakes it. This is why the host
///    process **must** be running a main run loop: an application always is, but
///    a plain `cargo test` binary is not, which is why the fixture tests live in
///    a `harness = false` integration test that pumps one.
///  - On the main thread, sleeping would deadlock: the thread that has to deliver
///    the callback would be the one blocked waiting for it. So it pumps instead.
fn wait_for(slot: &Slot, deadline: Instant) {
    // SAFETY: a libSystem call with no arguments and no side effects.
    if unsafe { pthread_main_np() } == 0 {
        slot.wait_until(deadline);
        return;
    }
    while !slot.settled() {
        let now = Instant::now();
        if now >= deadline {
            return;
        }
        let slice = (deadline - now).min(Duration::from_millis(20)).as_secs_f64();
        // SAFETY: a plain CoreFoundation call on the current thread's run loop.
        unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, slice.max(0.001), 1) };
    }
}

/// What `start_analysis` hands back: the identifier, and everything to keep alive.
struct Started {
    id: i32,
    request: *mut AnyObject,
    progress: *mut Block<dyn Fn(f64)>,
    completion: *mut Block<dyn Fn(*mut AnyObject, *mut AnyObject)>,
}

/// Test seam for the main-queue ordering the reclamation rule depends on.
///
/// Exposes exactly what `ReturnGuard` does, so a test on the main thread can show
/// that an acknowledgement submitted from inside the current main-queue item
/// cannot be observed until that item has finished and the queue has been driven.
/// Not used by anything in the shipping path.
#[doc(hidden)]
pub struct AckProbe(Arc<Slot>);

#[doc(hidden)]
impl AckProbe {
    /// Submit an acknowledgement exactly as a completion does.
    pub fn submit() -> Self {
        let slot = Slot::new();
        let handle = slot.clone();
        slot.mark_returned();
        if unsafe { pthread_main_np() } == 0 {
            slot.mark_off_main();
        } else {
            // SAFETY: submitting an owned block to the main queue, which copies it.
            unsafe { on_main_queue(move || handle.acknowledge()) };
        }
        Self(slot)
    }

    pub fn acknowledged(&self) -> bool {
        self.0.acknowledged()
    }

    /// Whether the caller was somewhere the ordering cannot be established.
    pub fn off_main(&self) -> bool {
        self.0.off_main()
    }
}

fn missing(what: &str) -> String {
    format!(
        "Apple Live Text is unavailable on this system: {what} was not found. It needs macOS 13 or later, and Apple may change or remove this unpublished interface in any release."
    )
}

fn class(name: &CStr) -> std::result::Result<&'static AnyClass, String> {
    AnyClass::get(name).ok_or_else(|| missing(&name.to_string_lossy()))
}

fn require(cls: &AnyClass, sel: Sel) -> std::result::Result<(), String> {
    if cls.instance_method(sel).is_none() {
        return Err(missing(&format!(
            "-[{} {}]",
            cls.name().to_string_lossy(),
            sel
        )));
    }
    Ok(())
}

fn probe() -> std::result::Result<(), String> {
    // SAFETY: loading a system framework by absolute path.
    let handle = unsafe { dlopen(FRAMEWORK.as_ptr() as *const c_char, RTLD_LAZY) };
    if handle.is_null() {
        return Err(missing("the VisionKitCore framework"));
    }
    let analyzer = class(c"VKCImageAnalyzer")?;
    let request = class(c"VKCImageAnalyzerRequest")?;
    require(
        analyzer,
        sel!(processRequest:progressHandler:completionHandler:),
    )?;
    require(analyzer, sel!(cancelRequestID:))?;
    require(analyzer, sel!(cancelAllRequests))?;
    require(request, sel!(initWithImage:requestType:))?;
    require(request, sel!(setLocales:))?;
    Ok(())
}

/// Wrap the frame's pixels in an `NSImage`, copying them exactly once.
///
/// `initWithBitmapDataPlanes:` is given a null plane so the representation
/// allocates and owns its buffer; the copy that follows is what makes the image
/// safe to hand to an asynchronous analysis that may outlive this call. Passing
/// the frame's own pointer would be faster and wrong.
fn image_from_frame(frame: &Frame) -> Result<Retained<NSImage>> {
    let width = frame.info.width as isize;
    let height = frame.info.height as isize;
    let stride = frame.info.stride;
    let needed = stride
        .checked_mul(frame.info.height as usize)
        .ok_or_else(|| CaptureError::new("observer", "frame dimensions overflow"))?;
    if width <= 0 || height <= 0 || frame.pixels.len() < needed {
        return Err(CaptureError::new(
            "observer",
            "frame has no pixels to observe",
        ));
    }

    // SAFETY: a null plane pointer asks AppKit to allocate its own storage; every
    // other argument describes the straight-alpha RGBA the capture produces.
    let rep: Option<Retained<NSBitmapImageRep>> = unsafe {
        let alloc: Allocated<NSBitmapImageRep> = NSBitmapImageRep::alloc();
        msg_send![
            alloc,
            initWithBitmapDataPlanes: std::ptr::null_mut::<*mut u8>(),
            pixelsWide: width,
            pixelsHigh: height,
            bitsPerSample: 8isize,
            samplesPerPixel: 4isize,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: NSDeviceRGBColorSpace,
            bitmapFormat: NSBitmapFormat::AlphaNonpremultiplied,
            bytesPerRow: stride as isize,
            bitsPerPixel: 32isize,
        ]
    };
    let rep = rep.ok_or_else(|| {
        CaptureError::new("observer", "could not allocate a bitmap for the observer")
    })?;

    // SAFETY: `bitmapData` is the buffer just allocated, `bytesPerRow * height`
    // long, and the source slice is checked to be at least that long above.
    unsafe {
        let destination = rep.bitmapData();
        if destination.is_null() {
            return Err(CaptureError::new(
                "observer",
                "the observer bitmap has no backing store",
            ));
        }
        std::ptr::copy_nonoverlapping(frame.pixels.as_ptr(), destination, needed);
    }

    let image = NSImage::initWithSize(NSImage::alloc(), NSSize::new(width as f64, height as f64));
    // SAFETY: `NSBitmapImageRep` is an `NSImageRep`.
    unsafe {
        let as_rep: &NSImageRep = &*(Retained::as_ptr(&rep) as *const NSImageRep);
        image.addRepresentation(as_rep);
    }
    Ok(image)
}

/// Build the request and start the analysis on the observer's one analyzer.
///
/// Returns the analyzer's request identifier — needed to cancel it — along with
/// the objects whose lifetime has to cover the asynchronous work.
fn start_analysis(analyzer: *mut AnyObject, image: &NSImage, slot: Arc<Slot>) -> Result<Started> {
    let request_class =
        class(c"VKCImageAnalyzerRequest").map_err(|e| CaptureError::new("unsupported", e))?;

    // SAFETY: every selector below was proved to exist in `probe`.
    unsafe {
        let allocated: Allocated<AnyObject> = msg_send![request_class, alloc];
        let request: Option<Retained<AnyObject>> = msg_send![
            allocated,
            initWithImage: image,
            requestType: ANALYSIS_TYPE_TEXT,
        ];
        let request = request
            .ok_or_else(|| CaptureError::new("observer", "Apple Live Text refused the image"))?;

        // Japanese first, English second: the second locale is what stops a line
        // of Latin UI chrome inside the crop from being forced into kana.
        let locales =
            NSArray::from_retained_slice(&[NSString::from_str("ja"), NSString::from_str("en")]);
        let _: () = msg_send![&*request, setLocales: &*locales];

        let progress = RcBlock::new(|_progress: f64| {});
        let completion = RcBlock::new(move |analysis: *mut AnyObject, error: *mut AnyObject| {
            // Dropped last, after the answer is stored, so a thread woken by the
            // answer cannot free the block this closure is executing from. It
            // records that the closure body finished — not that the invocation
            // has returned; see `Outstanding::release`.
            let _returned = ReturnGuard(slot.clone());
            slot.fill(extract(analysis, error));
        });

        // The analyzer answers with an identifier for this analysis, which is
        // what `cancelRequestID:` takes. objc2 checks the encoding at run time,
        // so a future release that changed this signature would be a message
        // rather than a silently wrong read.
        let id: i32 = msg_send![
            analyzer,
            processRequest: &*request,
            progressHandler: &*progress,
            completionHandler: &*completion,
        ];

        Ok(Started {
            id,
            request: Retained::into_raw(request),
            progress: RcBlock::into_raw(progress),
            completion: RcBlock::into_raw(completion),
        })
    }
}

/// Read everything we need out of the analysis, inside the callback.
///
/// Nothing Objective-C escapes this function. By the time it returns, the result
/// is owned Rust data, which is what makes a late callback harmless.
fn extract(
    analysis: *mut AnyObject,
    error: *mut AnyObject,
) -> std::result::Result<Vec<TextLine>, String> {
    if !error.is_null() {
        // SAFETY: an NSError, if VisionKit passed one.
        let description: Option<Retained<NSString>> =
            unsafe { msg_send![error, localizedDescription] };
        return Err(description
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Apple Live Text reported an error".to_string()));
    }
    if analysis.is_null() {
        return Ok(Vec::new());
    }

    autoreleasepool(|_| {
        // SAFETY: every selector is probed before it is sent, so a build where
        // one is absent reports a message rather than trapping.
        unsafe {
            let responds: bool = msg_send![analysis, respondsToSelector: sel!(allLines)];
            if !responds {
                return Err(missing("-[VKCImageAnalysis allLines]"));
            }
            let lines: *mut AnyObject = msg_send![analysis, allLines];
            if lines.is_null() {
                return Ok(Vec::new());
            }
            let count: usize = msg_send![lines, count];
            let mut out = Vec::with_capacity(count);
            for index in 0..count {
                let line: *mut AnyObject = msg_send![lines, objectAtIndex: index];
                if line.is_null() {
                    continue;
                }
                let string: Option<Retained<NSString>> = msg_send![line, string];
                let Some(string) = string else { continue };
                let text = string.to_string();
                if text.trim().is_empty() {
                    continue;
                }
                let has_quad: bool = msg_send![line, respondsToSelector: sel!(quad)];
                let rect = if has_quad {
                    let quad: *mut AnyObject = msg_send![line, quad];
                    if quad.is_null() {
                        NSRect::ZERO
                    } else {
                        let responds: bool =
                            msg_send![quad, respondsToSelector: sel!(boundingBox)];
                        if responds {
                            msg_send![quad, boundingBox]
                        } else {
                            NSRect::ZERO
                        }
                    }
                } else {
                    NSRect::ZERO
                };
                out.push(TextLine {
                    text,
                    x: rect.origin.x,
                    y: rect.origin.y,
                    width: rect.size.width,
                    height: rect.size.height,
                });
            }
            Ok(out)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FrameInfo;

    const TIMEOUT: Duration = Duration::from_secs(10);

    fn empty_frame() -> Frame {
        Frame {
            info: FrameInfo {
                source_id: "empty".into(),
                width: 0,
                height: 0,
                stride: 0,
                full_width: 0,
                full_height: 0,
                crop_pixels: [0, 0, 0, 0],
                scale_factor: 1.0,
                source_bounds: None,
                pixel_format: "rgba8",
                color_space: "srgb",
                resolve_ms: 0.0,
                acquisition_ms: 0.0,
                pixels_ms: 0.0,
                total_ms: 0.0,
            },
            pixels: Vec::new(),
        }
    }


    #[test]
    fn the_private_api_is_probed_rather_than_assumed() {
        let mut observer = LiveTextObserver::new();
        // Before any use it reports optimistically; after a probe it tells the truth.
        let _ = observer.ensure_available();
        let status = observer.status();
        assert_eq!(status.engine, "apple-live-text");
        assert_eq!(status.minimum_os, "macOS 13");
        assert!(status.private_api, "the maintenance assumption is disclosed");
        if !status.supported {
            // A machine without VisionKitCore must say so in a sentence a user
            // can act on, and must never claim to have read anything.
            assert!(status.detail.contains("macOS 13"), "{}", status.detail);
            let error = observer.observe(&empty_frame(), TIMEOUT).unwrap_err();
            assert_eq!(error.code, "unsupported");
        }
    }

    #[test]
    fn a_frame_with_no_pixels_is_refused_before_any_analysis_starts() {
        let mut observer = LiveTextObserver::new();
        if !observer.status_after_probe().supported {
            eprintln!("skipped: Apple Live Text is unavailable on this host");
            return;
        }
        let error = observer.observe(&empty_frame(), TIMEOUT).unwrap_err();
        assert_eq!(error.code, "observer");
        assert!(
            observer.outstanding.is_none(),
            "nothing was left outstanding"
        );
    }

    /// Automatic scanning calls this several times a second for hours.
    /// Stand in for an analysis that was started and has not returned.
    ///
    /// The pointers are null and are never dereferenced on the paths under test:
    /// every one of them refuses before touching anything, which is the property
    /// being tested. The entry is taken apart by hand rather than released.
    fn stalled(observer: &mut LiveTextObserver, slot: Arc<Slot>, started_at: Instant) {
        observer.outstanding = Some(Outstanding {
            slot,
            request: std::ptr::null_mut(),
            progress: std::ptr::null_mut(),
            completion: std::ptr::null_mut(),
            id: 7,
            started_at,
            cancelled: true,
        });
    }

    fn discard(observer: &mut LiveTextObserver) {
        if let Some(held) = observer.outstanding.take() {
            std::mem::forget(held);
        }
    }

    #[test]
    fn an_unreturned_analysis_blocks_another_from_starting() {
        let mut observer = LiveTextObserver::new();
        let slot = Slot::new();
        stalled(&mut observer, slot.clone(), Instant::now());

        let error = observer.reap().unwrap_err();
        assert_eq!(error.code, "busy");
        assert!(
            observer.outstanding.is_some(),
            "and it is still being held, not dropped"
        );
        discard(&mut observer);
    }

    /// The property the whole design turns on.
    #[test]
    fn elapsed_time_alone_never_permits_a_release_or_another_analysis() {
        let mut observer = LiveTextObserver::new();
        let slot = Slot::new();
        // Long past any plausible grace period, and past the stall threshold.
        stalled(
            &mut observer,
            slot.clone(),
            Instant::now() - STALL_REPORT_AFTER - Duration::from_secs(600),
        );

        let error = observer.reap().unwrap_err();
        assert_eq!(
            error.code, "stalled",
            "it reports, rather than assuming the analysis must be over"
        );
        assert!(
            observer.outstanding.is_some(),
            "and it still holds everything the analysis could touch"
        );
        assert!(error.message.contains("restart"), "{}", error.message);

        // Terminal: it does not quietly resume on the next call either.
        let again = observer.reap().unwrap_err();
        assert_eq!(again.code, "stalled");
        assert!(observer.outstanding.is_some());
        discard(&mut observer);
    }

    #[test]
    fn an_acknowledgement_cannot_be_observed_off_the_main_thread() {
        // The unit test harness runs on a spawned thread, which is exactly the
        // case the ordering rule cannot cover: the observer must refuse rather
        // than reclaim. The main-thread ordering itself is shown in
        // tests/livetext.rs, which owns the process's main thread.
        let probe = AckProbe::submit();
        assert!(probe.off_main(), "a worker thread cannot order the callback");
        assert!(!probe.acknowledged(), "and nothing is acknowledged there");
    }

    #[test]
    fn an_analysis_delivered_off_the_main_thread_stalls_rather_than_reclaims() {
        let mut observer = LiveTextObserver::new();
        let slot = Slot::new();
        stalled(&mut observer, slot.clone(), Instant::now());
        slot.fill(Ok(Vec::new()));
        slot.mark_returned();
        slot.mark_off_main();

        let error = observer.reap().unwrap_err();
        assert_eq!(error.code, "stalled");
        assert!(error.message.contains("off the main thread"), "{}", error.message);
        assert!(
            observer.outstanding.is_some(),
            "nothing was released on a path whose ordering is unknown"
        );
        discard(&mut observer);
    }

    #[test]
    fn a_settled_answer_is_still_not_enough_to_release_the_block() {
        // Waking a thread with the answer happens *inside* the completion
        // closure, which runs in the block's own allocation. Only the closure
        // having returned makes freeing it safe.
        let mut observer = LiveTextObserver::new();
        let slot = Slot::new();
        stalled(&mut observer, slot.clone(), Instant::now());

        slot.fill(Ok(Vec::new()));
        assert!(slot.settled(), "the answer is available");
        assert!(!slot.acknowledged(), "but the main queue has not acknowledged it");
        assert_eq!(observer.reap().unwrap_err().code, "busy");
        assert!(observer.outstanding.is_some());
        discard(&mut observer);
    }

    #[test]
    fn an_acknowledged_completion_is_what_releases_the_analysis_and_permits_the_next() {
        let mut observer = LiveTextObserver::new();
        let slot = Slot::new();
        stalled(&mut observer, slot.clone(), Instant::now());

        slot.fill(Ok(Vec::new()));
        slot.mark_returned();
        slot.acknowledge();
        // The stand-in holds null pointers, so the entry is taken apart here
        // rather than run through `release`.
        assert!(observer.outstanding.as_ref().unwrap().slot.acknowledged());
        discard(&mut observer);
        assert!(observer.reap().is_ok(), "and the next analysis may start");
    }

    /// The guard's ordering, which is all it claims.
    ///
    /// It proves the closure *body* finished after the answer was stored. It does
    /// not prove the `block2` trampoline has unwound, and nothing here asserts
    /// that it does — see `Outstanding::release` for what makes the deferred
    /// release sound.
    #[test]
    fn the_return_guard_marks_the_closure_body_finished_after_the_answer_is_stored() {
        let slot = Slot::new();
        {
            let _returned = ReturnGuard(slot.clone());
            slot.fill(Ok(Vec::new()));
            assert!(slot.settled(), "the answer is available immediately");
            assert!(
                !slot.returned(),
                "but not while the closure body is still running"
            );
        }
        assert!(slot.returned(), "and set once its scope ends");
    }

    #[test]
    fn one_analyzer_is_created_however_many_times_it_is_asked_for() {
        let mut observer = LiveTextObserver::new();
        if !observer.status_after_probe().supported {
            eprintln!("skipped: Apple Live Text is unavailable on this host");
            return;
        }
        let first = observer.analyzer().expect("an analyzer");
        for _ in 0..5 {
            assert_eq!(observer.analyzer().expect("an analyzer"), first);
        }
    }

    #[test]
    fn a_late_callback_writes_only_to_its_own_slot_and_never_wins_twice() {
        let slot = Slot::new();
        slot.fill(Ok(vec![TextLine {
            text: "先".into(),
            x: 0.0,
            y: 0.0,
            width: 1.0,
            height: 1.0,
        }]));
        // A second, later delivery for the same analysis must not overwrite the
        // answer that was already taken as authoritative.
        slot.fill(Err("too late".into()));
        let answer = slot.take().expect("an answer").expect("the first one");
        assert_eq!(answer.len(), 1);
        assert_eq!(answer[0].text, "先");
        assert!(slot.take().is_none(), "and it is consumed exactly once");
    }

    #[test]
    fn a_null_analysis_is_no_text_and_an_error_is_reported() {
        assert!(extract(std::ptr::null_mut(), std::ptr::null_mut())
            .expect("no text")
            .is_empty());
    }

    impl LiveTextObserver {
        fn status_after_probe(&mut self) -> ObserverStatus {
            let _ = self.ensure_available();
            self.status()
        }
    }
}

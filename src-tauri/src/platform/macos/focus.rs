//! Bringing one particular window to the front, wherever it is — behind other windows, or a
//! full-screen app in a Space of its own — and the Accessibility permission that helps.
//!
//! `NSRunningApplication.activate` brings an *application* forward, and macOS then picks which
//! of its Spaces to show: an emulator with its library on the desktop and its game in full
//! screen could land on the library. Two ways name the window instead:
//!
//!  - **SkyLight**, no permission: `_SLPSSetFrontProcessWithOptions` with the window's id makes
//!    the process frontmost with that window in front, and the window server switches to the
//!    window's Space. A synthetic "make key window" event record makes it the key window too.
//!    Private, resolved at run time like `spaces.rs`; the switcher AltTab focuses windows the
//!    same way. A macOS without them falls back to activating the application.
//!  - **Accessibility**, once the reader allows Kimochi in Privacy & Security: `AXRaise` and
//!    `AXMain` on the window's accessibility element, the documented way to order one window
//!    of another application. Only windows on the Space that is showing have an element, so it
//!    complements the first rather than replacing it. It also answers `AXFullScreen`.
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_foundation::{ns_string, NSArray, NSDictionary, NSNumber, NSString};
use std::ffi::{c_char, c_void};
use std::sync::OnceLock;

type CFTypeRef = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(element: CFTypeRef, attribute: CFTypeRef, value: *mut CFTypeRef) -> i32;
    fn AXUIElementSetAttributeValue(element: CFTypeRef, attribute: CFTypeRef, value: CFTypeRef) -> i32;
    fn AXUIElementPerformAction(element: CFTypeRef, action: CFTypeRef) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(value: CFTypeRef);
    static kCFBooleanTrue: CFTypeRef;
}

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}
/// `RTLD_DEFAULT` on Darwin: search every image already loaded.
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

#[repr(C)]
#[derive(Default)]
struct ProcessSerialNumber {
    high: u32,
    low: u32,
}

type GetProcessForPid = unsafe extern "C" fn(i32, *mut ProcessSerialNumber) -> i32;
type SetFrontProcess = unsafe extern "C" fn(*mut ProcessSerialNumber, u32, u32) -> i32;
type PostEventRecord = unsafe extern "C" fn(*mut ProcessSerialNumber, *mut u8) -> i32;
type GetWindow = unsafe extern "C" fn(CFTypeRef, *mut u32) -> i32;

struct Calls {
    process_for_pid: GetProcessForPid,
    set_front: SetFrontProcess,
    post_event: PostEventRecord,
}

fn find(name: &std::ffi::CStr) -> Option<*mut c_void> {
    let symbol = unsafe { dlsym(RTLD_DEFAULT, name.as_ptr()) };
    (!symbol.is_null()).then_some(symbol)
}

fn calls() -> Option<&'static Calls> {
    static CALLS: OnceLock<Option<Calls>> = OnceLock::new();
    CALLS
        .get_or_init(|| unsafe {
            Some(Calls {
                process_for_pid: std::mem::transmute::<*mut c_void, GetProcessForPid>(find(c"GetProcessForPID")?),
                set_front: std::mem::transmute::<*mut c_void, SetFrontProcess>(find(c"_SLPSSetFrontProcessWithOptions")?),
                post_event: std::mem::transmute::<*mut c_void, PostEventRecord>(find(c"SLPSPostEventRecordTo")?),
            })
        })
        .as_ref()
}

/// `_AXUIElementGetWindow`: the window-server id behind an accessibility window element.
fn element_window() -> Option<GetWindow> {
    static CALL: OnceLock<Option<GetWindow>> = OnceLock::new();
    *CALL.get_or_init(|| unsafe {
        find(c"_AXUIElementGetWindow").map(|f| std::mem::transmute::<*mut c_void, GetWindow>(f))
    })
}

/// `kCPSUserGenerated`: as if the reader had clicked the window.
const USER_GENERATED: u32 = 0x200;

/// Whether Kimochi may use Accessibility. A query: never prompts.
pub fn trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

/// Ask for Accessibility: macOS shows its own prompt (once per launch at most), which offers to
/// open Privacy & Security; the pane is opened as well, since the prompt does not reappear.
pub fn request() -> bool {
    let granted = objc2::rc::autoreleasepool(|_| unsafe {
        let key = ns_string!("AXTrustedCheckOptionPrompt");
        let value = NSNumber::new_bool(true);
        let options = NSDictionary::from_slices(&[key], &[&*value]);
        AXIsProcessTrustedWithOptions(Retained::as_ptr(&options).cast())
    });
    if !granted {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            .spawn();
    }
    granted
}

/// Owns one +1 Core Foundation reference.
struct Owned(CFTypeRef);
impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0) };
        }
    }
}

/// The accessibility element of window `number` of process `pid`, when it has one: the
/// application must be on the Space that is showing for its windows to be listed.
fn window_element(pid: i32, number: u32) -> Option<Owned> {
    if !trusted() {
        return None;
    }
    let get_window = element_window()?;
    unsafe {
        let app = Owned(AXUIElementCreateApplication(pid));
        if app.0.is_null() {
            return None;
        }
        let mut value: CFTypeRef = std::ptr::null();
        let attribute = ns_string!("AXWindows");
        if AXUIElementCopyAttributeValue(app.0, (attribute as *const NSString).cast(), &mut value) != 0 {
            return None;
        }
        let list = Owned(value);
        let windows = &*(list.0 as *const NSArray<AnyObject>);
        for window in windows.iter() {
            let element: CFTypeRef = Retained::as_ptr(&window).cast();
            let mut id = 0u32;
            if get_window(element, &mut id) == 0 && id == number {
                // Retained by the copy we return; `list` releases the array.
                let _ = Retained::into_raw(window);
                return Some(Owned(element));
            }
        }
        None
    }
}

/// `AXFullScreen` of the window, when Accessibility is allowed and the window is reachable.
pub fn is_full_screen(pid: i32, number: u32) -> Option<bool> {
    let element = window_element(pid, number)?;
    unsafe {
        let mut value: CFTypeRef = std::ptr::null();
        let attribute = ns_string!("AXFullScreen");
        if AXUIElementCopyAttributeValue(element.0, (attribute as *const NSString).cast(), &mut value) != 0 {
            return None;
        }
        let value = Owned(value);
        let number = &*(value.0 as *const NSNumber);
        Some(number.boolValue())
    }
}

/// Bring window `number` of process `pid` to the front, switching to its Space if it is on
/// another. True when either route took; the caller activates the application otherwise.
pub fn front_window(pid: i32, number: u32) -> bool {
    let mut fronted = false;
    if let Some(calls) = calls() {
        let mut psn = ProcessSerialNumber::default();
        unsafe {
            if (calls.process_for_pid)(pid, &mut psn) == 0
                && (calls.set_front)(&mut psn, number, USER_GENERATED) == 0
            {
                fronted = true;
                make_key(calls, &mut psn, number);
            }
        }
    }
    if let Some(element) = window_element(pid, number) {
        unsafe {
            let main = ns_string!("AXMain");
            let raise = ns_string!("AXRaise");
            let _ = AXUIElementSetAttributeValue(element.0, (main as *const NSString).cast(), kCFBooleanTrue);
            fronted |= AXUIElementPerformAction(element.0, (raise as *const NSString).cast()) == 0;
        }
    }
    fronted
}

/// The window server's "make key window" event record, posted as a press and a release.
/// The layout is undocumented; it is the one window managers on the platform use.
unsafe fn make_key(calls: &Calls, psn: &mut ProcessSerialNumber, number: u32) {
    let mut bytes = [0u8; 0xf8];
    bytes[0x04] = 0xf8;
    bytes[0x3a] = 0x10;
    bytes[0x3c..0x40].copy_from_slice(&number.to_ne_bytes());
    bytes[0x20..0x30].fill(0xff);
    bytes[0x08] = 0x01;
    (calls.post_event)(psn, bytes.as_mut_ptr());
    bytes[0x08] = 0x02;
    (calls.post_event)(psn, bytes.as_mut_ptr());
}

//! Which Space (Mission Control desktop or full-screen app) a window lives on.
//!
//! The window server answers this only through SkyLight's `CGS…` calls, which are private;
//! every window manager and switcher on the platform (yabai, AltTab, Hammerspoon) uses the
//! same three. They are looked up at run time rather than linked, so a macOS that drops one
//! costs the picker its windows on other Spaces and nothing else: `Spaces::current()` is
//! `None` and callers keep to the windows on screen.
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::msg_send;
use objc2_foundation::{ns_string, NSArray, NSDictionary, NSNumber, NSString};
use std::collections::HashMap;
use std::ffi::{c_char, c_void};
use std::sync::OnceLock;

type MainConnection = unsafe extern "C" fn() -> i32;
type ManagedDisplaySpaces = unsafe extern "C" fn(i32) -> *mut c_void;
type SpacesForWindows = unsafe extern "C" fn(i32, i32, *const c_void) -> *mut c_void;

struct Calls {
    connection: MainConnection,
    display_spaces: ManagedDisplaySpaces,
    window_spaces: SpacesForWindows,
}

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}
/// `RTLD_DEFAULT` on Darwin: search every image already loaded (CoreGraphics re-exports SkyLight).
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

fn calls() -> Option<&'static Calls> {
    static CALLS: OnceLock<Option<Calls>> = OnceLock::new();
    CALLS
        .get_or_init(|| unsafe {
            let find = |name: &std::ffi::CStr| {
                let symbol = dlsym(RTLD_DEFAULT, name.as_ptr());
                (!symbol.is_null()).then_some(symbol)
            };
            Some(Calls {
                connection: std::mem::transmute::<*mut c_void, MainConnection>(find(c"CGSMainConnectionID")?),
                display_spaces: std::mem::transmute::<*mut c_void, ManagedDisplaySpaces>(find(
                    c"CGSCopyManagedDisplaySpaces",
                )?),
                window_spaces: std::mem::transmute::<*mut c_void, SpacesForWindows>(find(c"CGSCopySpacesForWindows")?),
            })
        })
        .as_ref()
}

/// `kCGSAllSpacesMask`: the window's Spaces whether or not they are showing.
const ALL_SPACES: i32 = 7;
/// `type` of a full-screen app's Space in `CGSCopyManagedDisplaySpaces`; desktops are 0.
const FULL_SCREEN_SPACE: i64 = 4;

/// Every Space on every display, as the window server reported it a moment ago.
pub struct Spaces {
    connection: i32,
    window_spaces: SpacesForWindows,
    /// The Space each display is showing.
    current: Vec<u64>,
    /// How each Space is named in Mission Control: "Desktop 2", or "Full screen".
    labels: HashMap<u64, String>,
    /// The Spaces that are a full-screen app's own.
    full_screen: std::collections::HashSet<u64>,
}

impl Spaces {
    pub fn current() -> Option<Self> {
        let calls = calls()?;
        objc2::rc::autoreleasepool(|_| unsafe {
            let connection = (calls.connection)();
            let displays: Retained<NSArray<NSDictionary<NSString, AnyObject>>> =
                Retained::from_raw((calls.display_spaces)(connection).cast())?;
            let mut current = Vec::new();
            let mut labels = HashMap::new();
            let mut full_screen = std::collections::HashSet::new();
            for display in displays.iter() {
                let id = |space: &NSDictionary<NSString, AnyObject>| -> Option<u64> {
                    let value = space.objectForKey(ns_string!("ManagedSpaceID"))?;
                    Some(msg_send![&*value, unsignedLongLongValue])
                };
                if let Some(space) = display.objectForKey(ns_string!("Current Space")) {
                    let space = &*(Retained::as_ptr(&space) as *const NSDictionary<NSString, AnyObject>);
                    current.extend(id(space));
                }
                let Some(list) = display.objectForKey(ns_string!("Spaces")) else { continue };
                let list = &*(Retained::as_ptr(&list) as *const NSArray<NSDictionary<NSString, AnyObject>>);
                let mut desktop = 0;
                for space in list.iter() {
                    let Some(space_id) = id(&space) else { continue };
                    let kind: i64 = space
                        .objectForKey(ns_string!("type"))
                        .map(|value| msg_send![&*value, longLongValue])
                        .unwrap_or(0);
                    let label = if kind == FULL_SCREEN_SPACE {
                        full_screen.insert(space_id);
                        "Full screen".to_owned()
                    } else {
                        desktop += 1;
                        format!("Desktop {desktop}")
                    };
                    labels.insert(space_id, label);
                }
            }
            Some(Spaces { connection, window_spaces: calls.window_spaces, current, labels, full_screen })
        })
    }

    /// The Spaces window `number` is on; empty for a window on none (closed, hidden or minimised).
    fn of(&self, number: u32) -> Vec<u64> {
        objc2::rc::autoreleasepool(|_| unsafe {
            let ids = NSArray::from_retained_slice(&[NSNumber::new_u32(number)]);
            let Some(spaces): Option<Retained<NSArray<NSNumber>>> = Retained::from_raw(
                (self.window_spaces)(self.connection, ALL_SPACES, Retained::as_ptr(&ids).cast()).cast(),
            ) else {
                return Vec::new();
            };
            spaces.iter().map(|n| n.unsignedLongLongValue()).collect()
        })
    }

    /// Whether window `number` is on a Space that some display is showing. False for a window
    /// on no Space at all (closed, minimised). The window server's own on-screen flag follows
    /// the slide between Spaces and only changes once it has finished; this changes as soon as
    /// the switch starts.
    pub fn showing(&self, number: u32) -> bool {
        self.of(number).iter().any(|space| self.current.contains(space))
    }

    /// Whether window `number` is a full-screen app's window: on a Space of the full-screen kind.
    /// Asked of the Space rather than the window's size, so it holds while macOS animates the
    /// window into or out of its Space, when its bounds are anything but the display's.
    pub fn is_full_screen(&self, number: u32) -> bool {
        self.of(number).iter().any(|space| self.full_screen.contains(space))
    }

    /// Mission Control's name for the Space window `number` is on, when that Space is not showing:
    /// the window is open and could be read, but only once the reader goes there.
    pub fn elsewhere(&self, number: u32) -> Option<String> {
        let spaces = self.of(number);
        if spaces.is_empty() || spaces.iter().any(|space| self.current.contains(space)) {
            return None;
        }
        spaces.iter().find_map(|space| self.labels.get(space).cloned())
    }
}

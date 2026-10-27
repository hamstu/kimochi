//! Virtual desktops (Task View), through the documented `IVirtualDesktopManager`.
//!
//! A window on another desktop is cloaked by DWM, so the picker used to drop it with the
//! suspended UWP surfaces; and the overlay family stayed on the desktop Kimochi started
//! on, so a game on another desktop got no overlay. The manager answers both: which desktop
//! a window is on, and — for this process's own windows only — moving one to another.
//!
//! Desktop names and order are not in that interface. Explorer keeps them under
//! `HKCU\…\Explorer\VirtualDesktops` (the ids in order, and any name the user gave one),
//! which is read for the label only; without it the label is "Another desktop".
use windows::core::{GUID, HSTRING};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_BINARY, RRF_RT_REG_SZ};
use windows::Win32::UI::Shell::{IVirtualDesktopManager, VirtualDesktopManager};

thread_local! {
    /// Per thread: a COM interface belongs to the apartment that created it.
    static MANAGER: Option<IVirtualDesktopManager> = unsafe {
        // Joins the thread's apartment, or finds one (the UI thread's STA); either will do.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        CoCreateInstance(&VirtualDesktopManager, None, CLSCTX_ALL).ok()
    };
}

/// `None` while the thread's locals are being destroyed: dropping `MANAGER` makes a COM call
/// that pumps messages, and a foreground event delivered then comes back here.
fn with_manager<R>(f: impl FnOnce(&IVirtualDesktopManager) -> Option<R>) -> Option<R> {
    MANAGER.try_with(|manager| manager.as_ref().and_then(f)).ok().flatten()
}

/// The desktop a window is on; `None` for one on every desktop, or none (the shell).
fn desktop_of(manager: &IVirtualDesktopManager, hwnd: HWND) -> Option<GUID> {
    unsafe { manager.GetWindowDesktopId(hwnd) }
        .ok()
        .filter(|id| *id != GUID::zeroed())
}

/// Where a window that is on another desktop is ("Desktop 3", or the name the user gave it);
/// `None` when it is on this one, or the manager cannot say.
pub(super) fn elsewhere(hwnd: HWND) -> Option<String> {
    with_manager(|manager| {
        if unsafe { manager.IsWindowOnCurrentVirtualDesktop(hwnd) }.ok()?.as_bool() {
            return None;
        }
        let id = desktop_of(manager, hwnd)?;
        Some(label(&id).unwrap_or_else(|| "Another desktop".to_owned()))
    })
}

/// Move `panels` (this process's overlay family) onto the desktop `foreground` is on, so
/// they appear wherever the reader just went. Panels already there are left alone.
pub(super) fn follow(foreground: HWND, panels: &[usize]) {
    with_manager(|manager| {
        let target = desktop_of(manager, foreground)?;
        for raw in panels {
            let panel = HWND(*raw as *mut core::ffi::c_void);
            if desktop_of(manager, panel).is_some_and(|id| id != target) {
                let _ = unsafe { manager.MoveWindowToDesktop(panel, &target) };
            }
        }
        Some(())
    });
}

const DESKTOPS_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops";

fn label(id: &GUID) -> Option<String> {
    let braced = format!("{{{id:?}}}");
    if let Some(name) = registry_string(&format!(r"{DESKTOPS_KEY}\Desktops\{braced}"), "Name") {
        if !name.trim().is_empty() {
            return Some(name);
        }
    }
    let order = registry_binary(DESKTOPS_KEY, "VirtualDesktopIDs")?;
    let position = order.chunks_exact(16).position(|bytes| guid_from_bytes(bytes) == *id)?;
    Some(format!("Desktop {}", position + 1))
}

/// A GUID as Windows lays one out in memory, which is how the desktop list stores them.
fn guid_from_bytes(bytes: &[u8]) -> GUID {
    GUID {
        data1: u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        data2: u16::from_le_bytes([bytes[4], bytes[5]]),
        data3: u16::from_le_bytes([bytes[6], bytes[7]]),
        data4: [bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]],
    }
}

fn registry_binary(key: &str, value: &str) -> Option<Vec<u8>> {
    let (key, value) = (HSTRING::from(key), HSTRING::from(value));
    let mut size = 0u32;
    unsafe { RegGetValueW(HKEY_CURRENT_USER, &key, &value, RRF_RT_REG_BINARY, None, None, Some(&mut size)) }
        .ok()
        .ok()?;
    let mut data = vec![0u8; size as usize];
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &key,
            &value,
            RRF_RT_REG_BINARY,
            None,
            Some(data.as_mut_ptr().cast()),
            Some(&mut size),
        )
    }
    .ok()
    .ok()?;
    data.truncate(size as usize);
    Some(data)
}

fn registry_string(key: &str, value: &str) -> Option<String> {
    let (key, value) = (HSTRING::from(key), HSTRING::from(value));
    let mut size = 0u32;
    unsafe { RegGetValueW(HKEY_CURRENT_USER, &key, &value, RRF_RT_REG_SZ, None, None, Some(&mut size)) }
        .ok()
        .ok()?;
    let mut data = vec![0u16; (size as usize).div_ceil(2)];
    unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            &key,
            &value,
            RRF_RT_REG_SZ,
            None,
            Some(data.as_mut_ptr().cast()),
            Some(&mut size),
        )
    }
    .ok()
    .ok()?;
    let text = String::from_utf16_lossy(&data);
    Some(text.trim_end_matches('\0').to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_ids_read_in_memory_order() {
        let id = GUID::from_u128(0x01234567_89ab_cdef_0011_223344556677);
        let bytes = [
            0x67, 0x45, 0x23, 0x01, 0xab, 0x89, 0xef, 0xcd, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
        ];
        assert_eq!(guid_from_bytes(&bytes), id);
        assert_eq!(format!("{{{id:?}}}"), "{01234567-89AB-CDEF-0011-223344556677}");
    }
}

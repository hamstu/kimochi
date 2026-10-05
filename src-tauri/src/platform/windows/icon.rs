//! Application icons as PNG, in-process: no `ExtractIcon` subprocess, no shell COM.
use super::super::AppIdentity;
use super::{process_image_path, rules, window_pid};
use windows::core::HSTRING;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
use windows::Win32::UI::Shell::{
    SHDefExtractIconW, SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, GetClassLongPtrW, GetIconInfo, SendMessageTimeoutW, GCLP_HICON, HICON, ICONINFO,
    ICON_BIG, SMTO_ABORTIFHUNG, SMTO_BLOCK, WM_GETICON,
};

/// PNG for an application's icon, as close to `target` pixels as the sources allow.
///
/// Identity is the pid when known (a window source carries one); otherwise the name is
/// matched against the image stem of each process with a top-level window, which is the
/// name `frontmost_app` and the picker report.
///
/// Sources, in order, keeping the first that is at least `target` wide and otherwise
/// the largest seen:
///
///  1. the icon the window shows in its title bar and taskbar button
///     (`WM_GETICON(ICON_BIG)`, with a 200 ms timeout so a hung app cannot stall us),
///     because emulators and game launchers often set one that differs from their exe;
///  2. the window class icon (`GCLP_HICON`);
///  3. the executable's own icon resource at `target` size (`SHDefExtractIconW`);
///  4. the shell's icon for the executable (`SHGetFileInfoW`, 32 px), which also covers
///     executables with no icon resource of their own.
pub fn app_icon_png(app: &AppIdentity, target: isize) -> Option<Vec<u8>> {
    let target = target.clamp(16, 256) as u32;
    let pid = app.pid.or_else(|| pid_for_name(&app.name))?;
    let window = super::window::representative_window(pid);
    let path = process_image_path(pid);
    // Icons from WM_GETICON / the class are shared with their owner: never destroyed.
    let sources: [&dyn Fn() -> Option<Rgba>; 4] = [
        &|| {
            window
                .and_then(window_icon)
                .and_then(|i| unsafe { icon_rgba(i) })
        },
        &|| {
            window
                .and_then(class_icon)
                .and_then(|i| unsafe { icon_rgba(i) })
        },
        &|| path.as_deref().and_then(|p| extracted_icon(p, target)),
        &|| path.as_deref().and_then(shell_icon),
    ];
    let mut best: Option<Rgba> = None;
    for source in sources {
        if let Some(candidate) = source() {
            if best.as_ref().is_none_or(|b| candidate.width > b.width) {
                best = Some(candidate);
            }
        }
        if best.as_ref().is_some_and(|b| b.width >= target) {
            break;
        }
    }
    best.and_then(encode)
}

/// The pid of the first process (front-most window first) whose image stem matches.
fn pid_for_name(name: &str) -> Option<u32> {
    let wanted = name.trim().trim_end_matches(".exe");
    if wanted.is_empty() {
        return None;
    }
    let mut seen = std::collections::HashSet::new();
    super::sources::top_level_windows()
        .into_iter()
        .map(window_pid)
        .filter(|pid| *pid != 0 && seen.insert(*pid))
        .find(|pid| {
            process_image_path(*pid)
                .is_some_and(|path| rules::image_stem(&path).eq_ignore_ascii_case(wanted))
        })
}

fn window_icon(hwnd: HWND) -> Option<HICON> {
    let mut result = 0usize;
    let answered = unsafe {
        SendMessageTimeoutW(
            hwnd,
            WM_GETICON,
            WPARAM(ICON_BIG as usize),
            LPARAM(0),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            200,
            Some(&mut result),
        )
    };
    (answered.0 != 0 && result != 0).then_some(HICON(result as *mut core::ffi::c_void))
}

fn class_icon(hwnd: HWND) -> Option<HICON> {
    let raw = unsafe { GetClassLongPtrW(hwnd, GCLP_HICON) };
    (raw != 0).then_some(HICON(raw as *mut core::ffi::c_void))
}

fn extracted_icon(path: &str, size: u32) -> Option<Rgba> {
    let mut icon = HICON::default();
    let hr = unsafe {
        SHDefExtractIconW(
            &HSTRING::from(path),
            0,
            0,
            Some(&mut icon),
            None,
            size & 0xFFFF,
        )
    };
    if hr.is_err() || icon.is_invalid() {
        return None;
    }
    let pixels = unsafe { icon_rgba(icon) };
    let _ = unsafe { DestroyIcon(icon) };
    pixels
}

fn shell_icon(path: &str) -> Option<Rgba> {
    let mut info = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            &HSTRING::from(path),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if ok == 0 || info.hIcon.is_invalid() {
        return None;
    }
    let pixels = unsafe { icon_rgba(info.hIcon) };
    let _ = unsafe { DestroyIcon(info.hIcon) };
    pixels
}

struct Rgba {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

/// Read a bitmap as top-down 32-bit BGRA.
unsafe fn dib_bgra(
    dc: windows::Win32::Graphics::Gdi::HDC,
    bitmap: HBITMAP,
    width: i32,
    height: i32,
) -> Option<Vec<u8>> {
    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // negative: top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    let lines = unsafe {
        GetDIBits(
            dc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr() as *mut core::ffi::c_void),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    (lines != 0).then_some(pixels)
}

/// An `HICON`'s pixels as straight-alpha RGBA.
///
/// 32-bit icons carry alpha in the colour bitmap. Older icons have an all-zero alpha
/// channel and a separate AND mask (white = transparent), which is applied instead.
/// Monochrome icons (no colour bitmap) are not worth supporting and return `None`.
unsafe fn icon_rgba(icon: HICON) -> Option<Rgba> {
    let mut info = ICONINFO::default();
    unsafe { GetIconInfo(icon, &mut info) }.ok()?;
    // GetIconInfo hands us copies of both bitmaps; they are ours to delete.
    let (color, mask) = (info.hbmColor, info.hbmMask);
    let result = (|| {
        if color.is_invalid() {
            return None;
        }
        let mut bm = BITMAP::default();
        let read = unsafe {
            GetObjectW(
                HGDIOBJ(color.0),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bm as *mut BITMAP as *mut core::ffi::c_void),
            )
        };
        let (width, height) = (bm.bmWidth, bm.bmHeight);
        if read == 0 || width <= 0 || height <= 0 || width > 1024 || height > 1024 {
            return None;
        }
        let dc = unsafe { CreateCompatibleDC(None) };
        if dc.is_invalid() {
            return None;
        }
        let mut pixels = unsafe { dib_bgra(dc, color, width, height) };
        if let Some(px) = pixels.as_mut() {
            if px.chunks_exact(4).all(|p| p[3] == 0) {
                let alpha = (!mask.is_invalid())
                    .then(|| unsafe { dib_bgra(dc, mask, width, height) })
                    .flatten();
                for (i, p) in px.chunks_exact_mut(4).enumerate() {
                    p[3] = match &alpha {
                        Some(m) if m[i * 4] != 0 => 0, // AND mask white: transparent
                        _ => 255,
                    };
                }
            }
            for p in px.chunks_exact_mut(4) {
                p.swap(0, 2); // BGRA -> RGBA
            }
        }
        let _ = unsafe { DeleteDC(dc) };
        pixels.map(|pixels| Rgba {
            width: width as u32,
            height: height as u32,
            pixels,
        })
    })();
    unsafe {
        if !color.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(color.0));
        }
        if !mask.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(mask.0));
        }
    }
    result
}

fn encode(image: Rgba) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, image.width, image.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&image.pixels).ok()?;
        writer.finish().ok()?;
    }
    Some(out)
}

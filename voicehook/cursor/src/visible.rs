//! Whether a cursor shows anything: games hide the cursor with a blank one as often as with none
//! (`CreateCursor` with an all-transparent mask, an empty `.cur`, a fully transparent PNG cursor).
//! Shared with the test harness (`cursortest/`), which judges what the screen shows the same way.
use std::ffi::c_void;
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, HBITMAP,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetIconInfo, HCURSOR, ICONINFO};

/// A bitmap as 32-bit top-down pixels: (width, height, pixels, bits per pixel it was made with).
unsafe fn pixels(bitmap: HBITMAP) -> Option<(i32, i32, Vec<u32>, u16)> {
    if bitmap.is_null() {
        return None;
    }
    let mut info: BITMAP = std::mem::zeroed();
    if GetObjectW(bitmap, std::mem::size_of::<BITMAP>() as i32, (&mut info as *mut BITMAP).cast::<c_void>()) == 0 {
        return None;
    }
    let (w, h) = (info.bmWidth, info.bmHeight.abs());
    // A cursor is at most 256 px a side; anything else is not one to judge.
    if w <= 0 || h <= 0 || w > 1024 || h > 1024 {
        return None;
    }
    let mut header: BITMAPINFO = std::mem::zeroed();
    header.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h,
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        ..std::mem::zeroed()
    };
    let mut out = vec![0u32; (w * h) as usize];
    let dc = CreateCompatibleDC(std::ptr::null_mut());
    if dc.is_null() {
        return None;
    }
    let lines = GetDIBits(dc, bitmap, 0, h as u32, out.as_mut_ptr().cast(), &mut header, DIB_RGB_COLORS);
    DeleteDC(dc);
    (lines == h).then_some((w, h, out, info.bmBitsPixel))
}

/// Whether drawing `cursor` leaves every pixel of the screen as it was. False when it cannot be
/// read: only a cursor known to be blank is replaced.
pub fn invisible(cursor: HCURSOR) -> bool {
    if cursor.is_null() {
        return true;
    }
    unsafe {
        let mut info: ICONINFO = std::mem::zeroed();
        if GetIconInfo(cursor, &mut info) == 0 {
            return false;
        }
        let mask = pixels(info.hbmMask);
        let color = pixels(info.hbmColor);
        for bitmap in [info.hbmMask, info.hbmColor] {
            if !bitmap.is_null() {
                DeleteObject(bitmap);
            }
        }
        let Some((w, mask_h, mask, _)) = mask else { return false };
        // A 1-bit mask pixel reads back black (0) or white.
        let set = |p: u32| p & 0x00FF_FFFF != 0;
        match color {
            // Monochrome: the mask is AND over XOR, each `mask_h / 2` rows. A pixel shows unless
            // it keeps the screen (AND 1) and flips nothing (XOR 0).
            None => {
                let half = (w * (mask_h / 2)) as usize;
                mask.len() >= half * 2 && (0..half).all(|i| set(mask[i]) && !set(mask[half + i]))
            }
            Some((cw, ch, color, bits)) => {
                if cw != w || ch != mask_h || color.len() != mask.len() {
                    return false;
                }
                // A 32-bit cursor with any alpha is drawn by its alpha alone.
                if bits == 32 && color.iter().any(|p| p >> 24 != 0) {
                    return false;
                }
                // Otherwise the mask keeps the screen and the colour is XORed onto it.
                mask.iter().zip(&color).all(|(m, c)| set(*m) && c & 0x00FF_FFFF == 0)
            }
        }
    }
}

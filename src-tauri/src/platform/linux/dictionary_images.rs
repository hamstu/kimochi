//! Fallback for AVIF omitted from some distributions' WebKitGTK builds.
//! GdkPixbuf uses the system HEIF/AVIF loader; no bundled decoder or version change.
use std::ffi::{c_char, c_void};

#[link(name = "gdk_pixbuf-2.0")]
unsafe extern "C" {
    fn gdk_pixbuf_loader_new_with_type(
        kind: *const c_char,
        error: *mut *mut glib::ffi::GError,
    ) -> *mut c_void;
    fn gdk_pixbuf_loader_write(
        loader: *mut c_void,
        data: *const u8,
        len: usize,
        error: *mut *mut glib::ffi::GError,
    ) -> i32;
    fn gdk_pixbuf_loader_close(loader: *mut c_void, error: *mut *mut glib::ffi::GError) -> i32;
    fn gdk_pixbuf_loader_get_pixbuf(loader: *mut c_void) -> *mut c_void;
    fn gdk_pixbuf_save_to_bufferv(
        pixbuf: *mut c_void,
        buffer: *mut *mut c_char,
        size: *mut usize,
        kind: *const c_char,
        keys: *mut *mut c_char,
        values: *mut *mut c_char,
        error: *mut *mut glib::ffi::GError,
    ) -> i32;
}

fn take_error(error: *mut glib::ffi::GError) -> String {
    if error.is_null() {
        return "System image decoder failed".into();
    }
    // SAFETY: GdkPixbuf returned an owned GError; consume it exactly once.
    unsafe {
        let message = std::ffi::CStr::from_ptr((*error).message)
            .to_string_lossy()
            .into_owned();
        glib::ffi::g_error_free(error);
        message
    }
}

#[tauri::command]
pub async fn linux_dictionary_image(content: Vec<u8>) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || convert(&content))
        .await
        .map_err(|e| e.to_string())?
}

fn convert(content: &[u8]) -> Result<Vec<u8>, String> {
    if content.is_empty() || content.len() > 32 * 1024 * 1024 {
        return Err("Dictionary AVIF must be between 1 byte and 32 MiB".into());
    }
    // SAFETY: the loader owns its pixbuf until unref; buffer/GError ownership is
    // released on all paths. GdkPixbuf decoding needs no GTK window or main loop.
    unsafe {
        let mut error = std::ptr::null_mut();
        let loader = gdk_pixbuf_loader_new_with_type(c"heif/avif".as_ptr(), &mut error);
        if loader.is_null() {
            return Err(format!(
                "AVIF fallback unavailable: {}. Install heif-gdk-pixbuf and libheif-plugin-aomdec.",
                take_error(error)
            ));
        }
        let written = gdk_pixbuf_loader_write(loader, content.as_ptr(), content.len(), &mut error);
        let mut close_error = std::ptr::null_mut();
        let closed = gdk_pixbuf_loader_close(loader, &mut close_error);
        let result = if written == 0 {
            if !close_error.is_null() {
                glib::ffi::g_error_free(close_error);
            }
            Err(take_error(error))
        } else if closed == 0 {
            Err(take_error(close_error))
        } else {
            let pixbuf = gdk_pixbuf_loader_get_pixbuf(loader);
            if pixbuf.is_null() {
                Err("AVIF decoder returned no image".into())
            } else {
                let mut buffer = std::ptr::null_mut();
                let mut size = 0;
                let saved = gdk_pixbuf_save_to_bufferv(
                    pixbuf,
                    &mut buffer,
                    &mut size,
                    c"png".as_ptr(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &mut error,
                );
                if saved == 0 {
                    Err(take_error(error))
                } else {
                    let bytes = std::slice::from_raw_parts(buffer.cast::<u8>(), size).to_vec();
                    glib::ffi::g_free(buffer.cast());
                    Ok(bytes)
                }
            }
        };
        glib::gobject_ffi::g_object_unref(loader.cast());
        result
    }
}

#[cfg(test)]
mod tests {
    use super::convert;

    #[test]
    fn rejects_empty_input_before_decoding() {
        assert!(convert(&[]).unwrap_err().contains("32 MiB"));
    }

    #[test]
    fn rejects_invalid_image_without_panicking() {
        assert!(convert(b"not an AVIF image").is_err());
    }
}

//! Fallback for AVIF omitted from some distributions' WebKitGTK builds.
//! Decodes with libavif, linked directly, so the AppImage carries it and its AV1 decoder like any
//! other library: no GdkPixbuf loader, loader cache or plugin path, which differ by distribution
//! (Arch's GdkPixbuf decodes through glycin and has no legacy loaders at all).
use std::ffi::{CStr, c_char, c_int, c_void};

/// `avifRGBImage` from avif.h; the same layout in every libavif with soname 16 (1.0 through 1.4).
#[repr(C)]
struct AvifRgbImage {
    width: u32,
    height: u32,
    depth: u32,
    format: c_int,
    chroma_upsampling: c_int,
    chroma_downsampling: c_int,
    avoid_libyuv: c_int,
    ignore_alpha: c_int,
    alpha_premultiplied: c_int,
    is_float: c_int,
    max_threads: c_int,
    pixels: *mut u8,
    row_bytes: u32,
}

const AVIF_RESULT_OK: c_int = 0;
const AVIF_RGB_FORMAT_RGBA: c_int = 1;
/// Dictionary images are small; refuse anything whose RGBA copy would pass ~256 MiB.
const MAX_PIXELS: u64 = 64 * 1024 * 1024;

#[link(name = "avif")]
unsafe extern "C" {
    fn avifDecoderCreate() -> *mut c_void;
    fn avifDecoderDestroy(decoder: *mut c_void);
    fn avifDecoderReadMemory(
        decoder: *mut c_void,
        image: *mut c_void,
        data: *const u8,
        size: usize,
    ) -> c_int;
    fn avifImageCreateEmpty() -> *mut c_void;
    fn avifImageDestroy(image: *mut c_void);
    fn avifRGBImageSetDefaults(rgb: *mut AvifRgbImage, image: *const c_void);
    fn avifRGBImageAllocatePixels(rgb: *mut AvifRgbImage) -> c_int;
    fn avifRGBImageFreePixels(rgb: *mut AvifRgbImage);
    fn avifImageYUVToRGB(image: *const c_void, rgb: *mut AvifRgbImage) -> c_int;
    fn avifResultToString(result: c_int) -> *const c_char;
    fn avifVersion() -> *const c_char;
    fn avifCodecVersions(out: *mut c_char);
}

fn describe(result: c_int) -> String {
    // SAFETY: libavif returns a static, NUL-terminated string for every result code.
    unsafe {
        CStr::from_ptr(avifResultToString(result))
            .to_string_lossy()
            .into_owned()
    }
}

#[tauri::command]
pub async fn linux_dictionary_image(content: Vec<u8>) -> Result<Vec<u8>, String> {
    tauri::async_runtime::spawn_blocking(move || convert(&content))
        .await
        .map_err(|e| e.to_string())?
}

/// AVIF bytes to PNG bytes.
fn convert(content: &[u8]) -> Result<Vec<u8>, String> {
    if content.is_empty() || content.len() > 32 * 1024 * 1024 {
        return Err("Dictionary AVIF must be between 1 byte and 32 MiB".into());
    }
    let (width, height, rgba) = decode(content)?;
    let mut png = Vec::new();
    let mut encoder = png::Encoder::new(&mut png, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
    writer.finish().map_err(|e| e.to_string())?;
    Ok(png)
}

/// The first frame as 8-bit RGBA, rows packed.
fn decode(content: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    // SAFETY: the decoder and image are created and destroyed here on every path; the RGB pixels
    // are allocated by libavif and freed by it after being copied out.
    unsafe {
        let decoder = avifDecoderCreate();
        let image = avifImageCreateEmpty();
        if decoder.is_null() || image.is_null() {
            if !decoder.is_null() {
                avifDecoderDestroy(decoder);
            }
            if !image.is_null() {
                avifImageDestroy(image);
            }
            return Err("AVIF decoder could not be created".into());
        }
        let result = (|| {
            let read = avifDecoderReadMemory(decoder, image, content.as_ptr(), content.len());
            if read != AVIF_RESULT_OK {
                return Err(format!("AVIF decode failed: {}", describe(read)));
            }
            let mut rgb = std::mem::zeroed::<AvifRgbImage>();
            avifRGBImageSetDefaults(&mut rgb, image);
            if rgb.width == 0
                || rgb.height == 0
                || u64::from(rgb.width) * u64::from(rgb.height) > MAX_PIXELS
            {
                return Err(format!(
                    "AVIF image {}×{} is out of range",
                    rgb.width, rgb.height
                ));
            }
            // Higher bit depths would otherwise come out as 16-bit samples.
            rgb.depth = 8;
            rgb.format = AVIF_RGB_FORMAT_RGBA;
            let allocated = avifRGBImageAllocatePixels(&mut rgb);
            if allocated != AVIF_RESULT_OK {
                return Err(format!(
                    "AVIF pixels could not be allocated: {}",
                    describe(allocated)
                ));
            }
            let converted = avifImageYUVToRGB(image, &mut rgb);
            let pixels = if converted == AVIF_RESULT_OK {
                let row = rgb.width as usize * 4;
                let mut packed = Vec::with_capacity(row * rgb.height as usize);
                for y in 0..rgb.height as usize {
                    let start = rgb.pixels.add(y * rgb.row_bytes as usize);
                    packed.extend_from_slice(std::slice::from_raw_parts(start, row));
                }
                Ok((rgb.width, rgb.height, packed))
            } else {
                Err(format!(
                    "AVIF colour conversion failed: {}",
                    describe(converted)
                ))
            };
            avifRGBImageFreePixels(&mut rgb);
            pixels
        })();
        avifImageDestroy(image);
        avifDecoderDestroy(decoder);
        result
    }
}

const FLAG: &str = "--check-avif";

/// `kimochi --check-avif <file>`: decodes a file with the libavif this binary loads (in an
/// AppImage, the bundled one) and exits, for the build's own check and for support.
pub fn run_check() -> bool {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(FLAG) {
        return false;
    }
    let mut codecs = [0 as c_char; 256];
    // SAFETY: avifCodecVersions writes at most 256 bytes, NUL-terminated; avifVersion is static.
    let (version, codecs) = unsafe {
        avifCodecVersions(codecs.as_mut_ptr());
        (
            CStr::from_ptr(avifVersion()).to_string_lossy().into_owned(),
            CStr::from_ptr(codecs.as_ptr())
                .to_string_lossy()
                .into_owned(),
        )
    };
    // AppRun changes directory; the AppImage runtime keeps the caller's in OWD.
    let path = args.get(2).map(|path| match std::env::var_os("OWD") {
        Some(owd) if std::path::Path::new(path).is_relative() => {
            std::path::Path::new(&owd).join(path)
        }
        _ => path.into(),
    });
    let outcome = match path {
        None => Err(format!("usage: {FLAG} <file.avif>")),
        Some(path) => std::fs::read(&path)
            .map_err(|e| format!("{}: {e}", path.display()))
            .and_then(|bytes| convert(&bytes).map(|png| (path, png.len()))),
    };
    match outcome {
        Ok((path, size)) => println!(
            "AVIF ok: {} decoded to a {size}-byte PNG with libavif {version} ({codecs})",
            path.display()
        ),
        Err(message) => {
            eprintln!("AVIF check failed with libavif {version} ({codecs}): {message}");
            std::process::exit(1);
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::{convert, decode};

    /// A 64×48 solid red AVIF, encoded by libheif's heif-enc.
    const SAMPLE: &[u8] = include_bytes!("testdata/sample.avif");

    #[test]
    fn decodes_avif_to_rgba_and_png() {
        let (width, height, rgba) = decode(SAMPLE).unwrap();
        assert_eq!((width, height, rgba.len()), (64, 48, 64 * 48 * 4));
        let (r, g, b, a) = (rgba[0], rgba[1], rgba[2], rgba[3]);
        assert!(r > 240 && g < 16 && b < 16 && a == 255, "{r} {g} {b} {a}");
        assert_eq!(
            &convert(SAMPLE).unwrap()[..8],
            &[137, 80, 78, 71, 13, 10, 26, 10]
        );
    }

    #[test]
    fn rejects_empty_input_before_decoding() {
        assert!(convert(&[]).unwrap_err().contains("32 MiB"));
    }

    #[test]
    fn rejects_invalid_image_without_panicking() {
        assert!(
            convert(b"not an AVIF image")
                .unwrap_err()
                .contains("AVIF decode failed")
        );
    }
}

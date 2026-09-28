//! Japanese test images, rendered here rather than downloaded or committed.
//!
//! The observer can only really be trusted once it has read actual Japanese
//! glyphs, and the fixtures have to come from somewhere. Rendering them with the
//! system's own fonts keeps the whole thing offline and self-contained: no asset
//! in the repository, nothing fetched, and the text in the image is a string a
//! test can compare against, which is what makes "did it read it correctly" a
//! question with an answer.
//!
//! Test support only. Nothing in the shipping path calls this.

use crate::{Frame, FrameInfo};
use objc2::rc::{autoreleasepool, Retained};
use objc2::AllocAnyThread;
use objc2_app_kit::{
    NSBitmapImageRep, NSColor, NSDeviceRGBColorSpace, NSFont, NSFontAttributeName,
    NSForegroundColorAttributeName, NSGraphicsContext, NSStringDrawing,
};
use objc2_foundation::{NSDictionary, NSPoint, NSString};

/// Where a line of text was asked to be drawn, in the image's own pixels with a
/// top-left origin — the same convention `TextLine` reports.
#[derive(Debug, Clone, Copy)]
pub struct Placement {
    pub x: f64,
    /// Distance from the **top** of the image to the top of the text.
    pub top: f64,
    pub size: f64,
}

/// Render lines of Japanese onto a white background and return them as a `Frame`.
///
/// The result is a straight-alpha RGBA frame identical in shape to one the screen
/// capture produces, so the observer is exercised through exactly the path a real
/// capture takes.
pub fn japanese_frame(width: u32, height: u32, lines: &[(&str, Placement)]) -> Frame {
    let pixels = autoreleasepool(|_| {
        let rep = bitmap(width, height);
        let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)
            .expect("a bitmap graphics context");
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&context));

        // Opaque white, so the glyphs have the contrast a dialogue box would.
        NSColor::whiteColor().setFill();
        objc2_app_kit::NSRectFill(objc2_foundation::NSRect::new(
            NSPoint::new(0.0, 0.0),
            objc2_foundation::NSSize::new(f64::from(width), f64::from(height)),
        ));

        for (text, placement) in lines {
            let font = NSFont::systemFontOfSize(placement.size);
            let attributes = NSDictionary::from_slices(
                &[unsafe { NSFontAttributeName }, unsafe {
                    NSForegroundColorAttributeName
                }],
                &[
                    &*font as &objc2::runtime::AnyObject,
                    &*NSColor::blackColor() as &objc2::runtime::AnyObject,
                ],
            );
            // AppKit draws from a bottom-left origin; the placement is given from
            // the top because that is how every other coordinate here is stated.
            let baseline = f64::from(height) - placement.top - placement.size * 1.3;
            let string = NSString::from_str(text);
            unsafe {
                string.drawAtPoint_withAttributes(
                    NSPoint::new(placement.x, baseline),
                    Some(&attributes),
                );
            }
        }

        context.flushGraphics();
        NSGraphicsContext::restoreGraphicsState_class();
        read_back(&rep, width, height)
    });

    Frame {
        info: FrameInfo {
            source_id: "fixture".into(),
            width,
            height,
            stride: width as usize * 4,
            full_width: width,
            full_height: height,
            crop_pixels: [0, 0, width, height],
            scale_factor: 1.0,
            source_bounds: None,
            pixel_format: "rgba8",
            color_space: "srgb",
            resolve_ms: 0.0,
            acquisition_ms: 0.0,
            pixels_ms: 0.0,
            total_ms: 0.0,
        },
        pixels,
    }
}

/// A representation that can back a CoreGraphics drawing context.
///
/// Premultiplied, unlike the observer's own input bitmap: a CGBitmapContext has
/// no unpremultiplied configuration, and `graphicsContextWithBitmapImageRep:`
/// answers nil for one. It makes no difference to what is read back, because the
/// fixture is drawn fully opaque.
fn bitmap(width: u32, height: u32) -> Retained<NSBitmapImageRep> {
    // SAFETY: a null plane asks AppKit for its own storage; the rest describes
    // premultiplied RGBA at 8 bits per sample.
    unsafe {
        objc2::msg_send![
            NSBitmapImageRep::alloc(),
            initWithBitmapDataPlanes: std::ptr::null_mut::<*mut u8>(),
            pixelsWide: width as isize,
            pixelsHigh: height as isize,
            bitsPerSample: 8isize,
            samplesPerPixel: 4isize,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: NSDeviceRGBColorSpace,
            bitmapFormat: objc2_app_kit::NSBitmapFormat::empty(),
            bytesPerRow: width as isize * 4,
            bitsPerPixel: 32isize,
        ]
    }
}

fn read_back(rep: &NSBitmapImageRep, width: u32, height: u32) -> Vec<u8> {
    let length = width as usize * height as usize * 4;
    // SAFETY: the buffer was allocated above with exactly this many bytes.
    unsafe {
        let data = rep.bitmapData();
        assert!(!data.is_null(), "the fixture bitmap has a backing store");
        std::slice::from_raw_parts(data, length).to_vec()
    }
}

//! DMA-BUF frames from a PipeWire screencast, read back to RGBA through EGL.
//!
//! Most producers (Mutter, KWin, the portals, Gamescope, Niri since September 2026) hand
//! Kimochi shared-memory buffers, which the stream maps and copies directly. Niri 26.04's
//! screencast offers DMA-BUF only (#273). For that case the stream also offers DMA-BUF formats,
//! after the shared-memory one, and [`Reader`] imports each buffer as an `EGLImage`, binds it
//! to a texture behind a framebuffer and reads the pixels with `glReadPixels`.
//!
//! `libEGL.so.1` is loaded at runtime, only when a stream wants DMA-BUF, so shared-memory
//! capture never depends on a GPU driver. The EGL display is made on the session's Wayland
//! display, so it uses the compositor's GPU, the one the buffers live on.
//!
//! The attribute list and modifier choice compile everywhere so their tests run on any host;
//! the EGL side is Linux-only.
//!
//! Original approach and first implementation by TAG (aidegaia), in #273.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

/// `DRM_FORMAT_MOD_INVALID`: the driver's implicit layout, described by no modifier.
pub(crate) const IMPLICIT_MODIFIER: u64 = 0x00ff_ffff_ffff_ffff;
/// DRM fourccs for the two layouts Niri renders (`BGRx` and `BGRA` in SPA's byte order).
pub(crate) const XRGB8888: u32 = u32::from_le_bytes(*b"XR24");
pub(crate) const ARGB8888: u32 = u32::from_le_bytes(*b"AR24");

const EGL_NONE: isize = 0x3038;
const EGL_WIDTH: isize = 0x3057;
const EGL_HEIGHT: isize = 0x3056;
const EGL_LINUX_DRM_FOURCC: isize = 0x3271;
/// `EGL_DMA_BUF_PLANEn_FD_EXT`; `+1` is the plane's offset, `+2` its pitch.
const PLANE_FD: [isize; 4] = [0x3272, 0x3275, 0x3278, 0x3440];
/// `EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT`; each plane's `LO`/`HI` pair follows the previous one.
const PLANE0_MODIFIER_LO: isize = 0x3443;

/// One plane of a DMA-BUF, as the PipeWire buffer describes it. The fd is borrowed.
pub(crate) struct Plane {
    pub(crate) fd: i32,
    pub(crate) offset: u32,
    pub(crate) stride: i32,
}

/// The modifiers to offer for a format, from what the driver reports as `(modifier,
/// external_only)`. External-only layouts can't back a `GL_TEXTURE_2D`, so they're dropped.
/// The implicit modifier always goes last: a producer that can't do explicit modifiers (or a
/// driver that lists none) still matches it.
pub(crate) fn usable_modifiers(reported: impl IntoIterator<Item = (u64, bool)>) -> Vec<u64> {
    let mut modifiers: Vec<u64> = Vec::new();
    for (modifier, external_only) in reported {
        if !external_only && modifier != IMPLICIT_MODIFIER && !modifiers.contains(&modifier) {
            modifiers.push(modifier);
        }
    }
    modifiers.push(IMPLICIT_MODIFIER);
    modifiers
}

/// `eglCreateImage` attributes for a `EGL_LINUX_DMA_BUF_EXT` image. `None` when the planes
/// can't describe an image (none, more than EGL takes, a closed fd or an empty stride).
fn image_attributes(fourcc: u32, modifier: u64, width: u32, height: u32, planes: &[Plane]) -> Option<Vec<isize>> {
    if planes.is_empty() || planes.len() > PLANE_FD.len() {
        return None;
    }
    let mut attrs = vec![EGL_WIDTH, width as isize, EGL_HEIGHT, height as isize, EGL_LINUX_DRM_FOURCC, fourcc as isize];
    for (index, plane) in planes.iter().enumerate() {
        if plane.fd < 0 || plane.stride <= 0 || plane.offset > i32::MAX as u32 {
            return None;
        }
        let fd = PLANE_FD[index];
        attrs.extend([fd, plane.fd as isize, fd + 1, plane.offset as isize, fd + 2, plane.stride as isize]);
        if modifier != IMPLICIT_MODIFIER {
            // EGL takes each half as a 32-bit attribute value.
            let lo = PLANE0_MODIFIER_LO + 2 * index as isize;
            attrs.extend([lo, modifier as u32 as i32 as isize, lo + 1, (modifier >> 32) as u32 as i32 as isize]);
        }
    }
    attrs.push(EGL_NONE);
    Some(attrs)
}

#[cfg(target_os = "linux")]
pub(crate) use egl::Reader;

#[cfg(target_os = "linux")]
mod egl {
    use super::{image_attributes, usable_modifiers, Plane};
    use libloading::Library;
    use std::ffi::{c_char, c_void, CStr};
    use std::ptr::{null, null_mut};
    use std::sync::OnceLock;
    use wayland_client::Connection;

    const EGL_EXTENSIONS: i32 = 0x3055;
    const EGL_LINUX_DMA_BUF: u32 = 0x3270;
    const EGL_NONE: i32 = 0x3038;
    const EGL_OPENGL_ES_API: u32 = 0x30a0;
    const EGL_PLATFORM_WAYLAND: u32 = 0x31d8;
    const EGL_SURFACE_TYPE: i32 = 0x3033;
    const EGL_RENDERABLE_TYPE: i32 = 0x3040;
    const EGL_OPENGL_ES2_BIT: i32 = 0x0004;
    const EGL_CONTEXT_CLIENT_VERSION: i32 = 0x3098;

    const GL_NO_ERROR: u32 = 0;
    const GL_EXTENSIONS: u32 = 0x1f03;
    const GL_TEXTURE_2D: u32 = 0x0de1;
    const GL_FRAMEBUFFER: u32 = 0x8d40;
    const GL_COLOR_ATTACHMENT0: u32 = 0x8ce0;
    const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8cd5;
    const GL_RGBA: u32 = 0x1908;
    const GL_UNSIGNED_BYTE: u32 = 0x1401;
    const GL_PACK_ALIGNMENT: u32 = 0x0d05;

    type Handle = *mut c_void;
    type Proc = unsafe extern "C" fn();
    type GetProcAddress = unsafe extern "C" fn(*const c_char) -> Option<Proc>;
    type QueryModifiers = unsafe extern "C" fn(Handle, i32, i32, *mut u64, *mut u32, *mut i32) -> u32;

    /// A table of C entry points, resolved by name; `None` if any is missing.
    macro_rules! api {
        ($name:ident { $($symbol:ident: fn($($arg:ty),*) $(-> $ret:ty)?),* $(,)? }) => {
            #[allow(non_snake_case)]
            struct $name {
                $($symbol: unsafe extern "C" fn($($arg),*) $(-> $ret)?,)*
            }
            impl $name {
                /// SAFETY: `resolve` must return the entry point named, whose C signature
                /// matches the field's.
                unsafe fn load(resolve: impl Fn(&CStr) -> Option<Proc>) -> Option<Self> {
                    Some(Self {
                        $($symbol: std::mem::transmute::<Proc, unsafe extern "C" fn($($arg),*) $(-> $ret)?>(
                            resolve(CStr::from_bytes_with_nul(concat!(stringify!($symbol), "\0").as_bytes()).ok()?)?
                        ),)*
                    })
                }
            }
        };
    }

    api!(Egl {
        eglGetPlatformDisplay: fn(u32, Handle, *const isize) -> Handle,
        eglInitialize: fn(Handle, *mut i32, *mut i32) -> u32,
        eglTerminate: fn(Handle) -> u32,
        eglQueryString: fn(Handle, i32) -> *const c_char,
        eglBindAPI: fn(u32) -> u32,
        eglChooseConfig: fn(Handle, *const i32, *mut Handle, i32, *mut i32) -> u32,
        eglCreateContext: fn(Handle, Handle, Handle, *const i32) -> Handle,
        eglDestroyContext: fn(Handle, Handle) -> u32,
        eglMakeCurrent: fn(Handle, Handle, Handle, Handle) -> u32,
        eglCreateImage: fn(Handle, Handle, u32, Handle, *const isize) -> Handle,
        eglDestroyImage: fn(Handle, Handle) -> u32,
    });

    api!(Gl {
        glGetString: fn(u32) -> *const u8,
        glGetError: fn() -> u32,
        glPixelStorei: fn(u32, i32),
        glGenTextures: fn(i32, *mut u32),
        glDeleteTextures: fn(i32, *const u32),
        glBindTexture: fn(u32, u32),
        glEGLImageTargetTexture2DOES: fn(u32, Handle),
        glGenFramebuffers: fn(i32, *mut u32),
        glDeleteFramebuffers: fn(i32, *const u32),
        glBindFramebuffer: fn(u32, u32),
        glFramebufferTexture2D: fn(u32, u32, u32, u32, i32),
        glCheckFramebufferStatus: fn(u32) -> u32,
        glReadPixels: fn(i32, i32, i32, i32, u32, u32, Handle),
    });

    /// The host's libEGL, loaded on first use and never unloaded: drivers (NVIDIA's among
    /// them) don't reliably survive `dlclose`.
    fn library() -> Option<&'static Library> {
        static LIBRARY: OnceLock<Option<Library>> = OnceLock::new();
        // SAFETY: loading libEGL runs only its own initialisers.
        LIBRARY.get_or_init(|| unsafe { Library::new("libEGL.so.1") }.ok()).as_ref()
    }

    fn has_extension(list: *const c_char, name: &str) -> bool {
        // SAFETY: EGL and GL return NUL-terminated strings that live as long as the display
        // or context they describe, which outlives this call.
        !list.is_null()
            && unsafe { CStr::from_ptr(list) }.to_bytes().split(|b| *b == b' ').any(|s| s == name.as_bytes())
    }

    /// An initialised EGL display with a current, surfaceless GLES 2 context. All calls,
    /// including the drop, happen on the PipeWire thread that made it.
    struct Display {
        egl: Egl,
        display: Handle,
        context: Handle,
        // Kept alive for the EGL display made on it; dropped after `eglTerminate`.
        _connection: Connection,
    }

    impl Drop for Display {
        fn drop(&mut self) {
            // SAFETY: `display` was initialised by this struct and `context` (if any) was made
            // on it; nothing else holds either.
            unsafe {
                if !self.context.is_null() {
                    (self.egl.eglMakeCurrent)(self.display, null_mut(), null_mut(), null_mut());
                    (self.egl.eglDestroyContext)(self.display, self.context);
                }
                (self.egl.eglTerminate)(self.display);
            }
        }
    }

    /// Reads DMA-BUF frames back to tightly packed RGBA. One per PipeWire thread: it is not
    /// `Send`, and its context is current on that thread.
    pub(crate) struct Reader {
        display: Display,
        gl: Gl,
        query_modifiers: Option<QueryModifiers>,
        pixels: Vec<u8>,
        warned: bool,
    }

    impl Reader {
        /// `None` when there's no Wayland display, no libEGL, or the driver can't import
        /// DMA-BUFs into a GLES 2 texture. The stream then offers shared memory only.
        pub(crate) fn new() -> Option<Self> {
            let reader = Self::open();
            if reader.is_none() {
                eprintln!("Wayland capture: DMA-BUF readback unavailable (no usable EGL); shared memory only");
            }
            reader
        }

        fn open() -> Option<Self> {
            let connection = Connection::connect_to_env().ok()?;
            let library = library()?;
            // SAFETY: every entry point is resolved by its EGL/GLES name with its C signature,
            // and each EGL object is checked before use. Failure paths drop `Display`, which
            // releases what was made so far.
            unsafe {
                let get_proc = *library.get::<GetProcAddress>(b"eglGetProcAddress\0").ok()?;
                let egl = Egl::load(|name| library.get::<Proc>(name.to_bytes_with_nul()).ok().map(|s| *s))?;
                let native = connection.backend().display_ptr().cast();
                let display = (egl.eglGetPlatformDisplay)(EGL_PLATFORM_WAYLAND, native, null());
                if display.is_null() || (egl.eglInitialize)(display, null_mut(), null_mut()) == 0 {
                    return None;
                }
                let mut display = Display { egl, display, context: null_mut(), _connection: connection };
                let (egl, d) = (&display.egl, display.display);
                let extensions = (egl.eglQueryString)(d, EGL_EXTENSIONS);
                if !has_extension(extensions, "EGL_EXT_image_dma_buf_import")
                    || !has_extension(extensions, "EGL_KHR_surfaceless_context")
                    || (egl.eglBindAPI)(EGL_OPENGL_ES_API) == 0
                {
                    return None;
                }
                let (mut config, mut count) = (null_mut(), 0);
                // EGL_SURFACE_TYPE 0: no surface at all, so any GLES 2 config will do.
                let attrs = [EGL_SURFACE_TYPE, 0, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_NONE];
                if (egl.eglChooseConfig)(d, attrs.as_ptr(), &mut config, 1, &mut count) == 0 || count == 0 {
                    return None;
                }
                let attrs = [EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE];
                let context = (egl.eglCreateContext)(d, config, null_mut(), attrs.as_ptr());
                display.context = context;
                if context.is_null() || (egl.eglMakeCurrent)(d, null_mut(), null_mut(), context) == 0 {
                    return None;
                }
                let gl = Gl::load(|name| get_proc(name.as_ptr()))?;
                if !has_extension((gl.glGetString)(GL_EXTENSIONS).cast(), "GL_OES_EGL_image") {
                    return None;
                }
                let query_modifiers = if has_extension(extensions, "EGL_EXT_image_dma_buf_import_modifiers") {
                    get_proc(c"eglQueryDmaBufModifiersEXT".as_ptr())
                        .map(|p| std::mem::transmute::<Proc, QueryModifiers>(p))
                } else {
                    None
                };
                Some(Self { display, gl, query_modifiers, pixels: Vec::new(), warned: false })
            }
        }

        /// The modifiers this driver can import `fourcc` with, implicit last.
        pub(crate) fn modifiers(&self, fourcc: u32) -> Vec<u64> {
            let mut reported = Vec::new();
            if let Some(query) = self.query_modifiers {
                let d = self.display.display;
                let mut count = 0;
                // SAFETY: the first call only counts; the second writes at most `count`
                // entries into buffers of that length.
                unsafe {
                    if query(d, fourcc as i32, 0, null_mut(), null_mut(), &mut count) != 0 && count > 0 {
                        let mut modifiers = vec![0u64; count as usize];
                        let mut external = vec![0u32; count as usize];
                        if query(d, fourcc as i32, count, modifiers.as_mut_ptr(), external.as_mut_ptr(), &mut count)
                            != 0
                        {
                            let n = (count.max(0) as usize).min(modifiers.len());
                            reported.extend(modifiers[..n].iter().zip(&external[..n]).map(|(m, e)| (*m, *e != 0)));
                        }
                    }
                }
            }
            usable_modifiers(reported)
        }

        /// Read one frame back as `width × height` RGBA rows (`width * 4` bytes each, top row
        /// first). `None` if the driver refuses the buffer; the first refusal is logged.
        pub(crate) fn read(
            &mut self,
            fourcc: u32,
            modifier: u64,
            width: u32,
            height: u32,
            planes: &[Plane],
        ) -> Option<&[u8]> {
            let attrs = image_attributes(fourcc, modifier, width, height, planes)?;
            let ok = self.read_into(&attrs, width, height);
            if !ok && !self.warned {
                self.warned = true;
                eprintln!(
                    "Wayland capture: could not read a DMA-BUF frame back (fourcc {fourcc:#x}, modifier {modifier:#x}, {} planes)",
                    planes.len()
                );
            }
            ok.then_some(self.pixels.as_slice())
        }

        fn read_into(&mut self, attrs: &[isize], width: u32, height: u32) -> bool {
            let Display { egl, display: d, context, .. } = &self.display;
            let gl = &self.gl;
            // SAFETY: the context is ours and current only on this thread. The plane fds in
            // `attrs` belong to the PipeWire buffer dequeued for this call, which isn't queued
            // back until we return; glReadPixels has finished with the image by then, and the
            // image, texture and framebuffer are all deleted before returning.
            unsafe {
                if (egl.eglMakeCurrent)(*d, null_mut(), null_mut(), *context) == 0 {
                    return false;
                }
                // Clear errors left from earlier calls, so the checks below see only ours.
                while (gl.glGetError)() != GL_NO_ERROR {}
                let image = (egl.eglCreateImage)(*d, null_mut(), EGL_LINUX_DMA_BUF, null_mut(), attrs.as_ptr());
                if image.is_null() {
                    return false;
                }
                let (mut texture, mut framebuffer) = (0, 0);
                (gl.glGenTextures)(1, &mut texture);
                (gl.glBindTexture)(GL_TEXTURE_2D, texture);
                (gl.glEGLImageTargetTexture2DOES)(GL_TEXTURE_2D, image);
                (gl.glGenFramebuffers)(1, &mut framebuffer);
                (gl.glBindFramebuffer)(GL_FRAMEBUFFER, framebuffer);
                (gl.glFramebufferTexture2D)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
                let mut ok = (gl.glGetError)() == GL_NO_ERROR
                    && (gl.glCheckFramebufferStatus)(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
                if ok {
                    // Row 0 of a texture-backed framebuffer is the buffer's first row, so the
                    // rows come back top first, as the shared-memory path has them.
                    self.pixels.resize(width as usize * height as usize * 4, 0);
                    (gl.glPixelStorei)(GL_PACK_ALIGNMENT, 4);
                    let out = self.pixels.as_mut_ptr().cast();
                    (gl.glReadPixels)(0, 0, width as i32, height as i32, GL_RGBA, GL_UNSIGNED_BYTE, out);
                    ok = (gl.glGetError)() == GL_NO_ERROR;
                }
                (gl.glBindFramebuffer)(GL_FRAMEBUFFER, 0);
                (gl.glDeleteFramebuffers)(1, &framebuffer);
                (gl.glBindTexture)(GL_TEXTURE_2D, 0);
                (gl.glDeleteTextures)(1, &texture);
                (egl.eglDestroyImage)(*d, image);
                ok
            }
        }
    }

    /// Imports a GPU buffer the way a Niri frame arrives (a GBM DMA-BUF with a padded stride),
    /// fills it through GL, then reads it back through a fresh import with [`Reader::read`].
    /// Needs a Wayland session with a GPU and libgbm:
    /// `cargo test --manifest-path capture-core/Cargo.toml --lib -- --ignored dmabuf_readback`.
    /// The fill goes through GL too, so this checks import, stride, framebuffer and row order
    /// on the real driver, not the fourcc's channel mapping (that one is fixed by the spec).
    #[cfg(test)]
    mod live {
        use super::super::{image_attributes, ARGB8888, IMPLICIT_MODIFIER, XRGB8888};
        use super::*;

        api!(Gbm {
            gbm_create_device: fn(i32) -> Handle,
            gbm_device_destroy: fn(Handle),
            gbm_bo_create: fn(Handle, u32, u32, u32, u32) -> Handle,
            gbm_bo_destroy: fn(Handle),
            gbm_bo_get_fd: fn(Handle) -> i32,
            gbm_bo_get_stride: fn(Handle) -> u32,
            gbm_bo_get_modifier: fn(Handle) -> u64,
        });
        api!(Upload {
            glTexSubImage2D: fn(u32, i32, i32, i32, i32, i32, u32, u32, *const c_void),
            glFinish: fn(),
        });
        const GBM_BO_USE_RENDERING: u32 = 1 << 2;

        /// Write tightly packed RGBA into the DMA-BUF through a texture bound to it.
        unsafe fn upload(reader: &Reader, attrs: &[isize], w: u32, h: u32, rgba: &[u8]) {
            let (egl, d, gl) = (&reader.display.egl, reader.display.display, &reader.gl);
            let get_proc = *library().unwrap().get::<GetProcAddress>(b"eglGetProcAddress\0").unwrap();
            let up = Upload::load(|name| get_proc(name.as_ptr())).unwrap();
            assert_ne!((egl.eglMakeCurrent)(d, null_mut(), null_mut(), reader.display.context), 0);
            let image = (egl.eglCreateImage)(d, null_mut(), EGL_LINUX_DMA_BUF, null_mut(), attrs.as_ptr());
            assert!(!image.is_null(), "eglCreateImage");
            let mut texture = 0;
            (gl.glGenTextures)(1, &mut texture);
            (gl.glBindTexture)(GL_TEXTURE_2D, texture);
            (gl.glEGLImageTargetTexture2DOES)(GL_TEXTURE_2D, image);
            (gl.glPixelStorei)(0x0cf5, 1); // GL_UNPACK_ALIGNMENT
            (up.glTexSubImage2D)(
                GL_TEXTURE_2D,
                0,
                0,
                0,
                w as i32,
                h as i32,
                GL_RGBA,
                GL_UNSIGNED_BYTE,
                rgba.as_ptr().cast(),
            );
            (up.glFinish)();
            assert_eq!((gl.glGetError)(), GL_NO_ERROR, "upload");
            (gl.glDeleteTextures)(1, &texture);
            (egl.eglDestroyImage)(d, image);
        }

        #[test]
        #[ignore = "needs a Wayland session with a GPU"]
        fn dmabuf_readback() {
            let mut reader = Reader::new().expect("EGL with DMA-BUF import");
            for fourcc in [XRGB8888, ARGB8888] {
                eprintln!("{fourcc:#x} modifiers: {:x?}", reader.modifiers(fourcc));
                assert_eq!(reader.modifiers(fourcc).last(), Some(&IMPLICIT_MODIFIER));
            }
            // SAFETY: test-only GBM calls with checked results; everything is released below.
            unsafe {
                let gbm_lib: &'static Library = Box::leak(Box::new(Library::new("libgbm.so.1").expect("libgbm")));
                let gbm = Gbm::load(|n| gbm_lib.get::<Proc>(n.to_bytes_with_nul()).ok().map(|s| *s)).unwrap();
                let node = std::fs::File::open("/dev/dri/renderD128").expect("render node");
                let device = (gbm.gbm_create_device)(std::os::fd::AsRawFd::as_raw_fd(&node));
                assert!(!device.is_null());
                let (w, h) = (37u32, 21u32); // odd sizes, so the stride is padded
                for (fourcc, alpha) in [(XRGB8888, false), (ARGB8888, true)] {
                    let bo = (gbm.gbm_bo_create)(device, w, h, fourcc, GBM_BO_USE_RENDERING);
                    assert!(!bo.is_null(), "gbm_bo_create");
                    let fd = std::os::fd::OwnedFd::from_raw_fd_checked((gbm.gbm_bo_get_fd)(bo));
                    let (stride, modifier) = ((gbm.gbm_bo_get_stride)(bo), (gbm.gbm_bo_get_modifier)(bo));
                    eprintln!("{fourcc:#x}: stride {stride} for width {w}, modifier {modifier:#x}");
                    let fd_raw = std::os::fd::AsRawFd::as_raw_fd(&fd);
                    let plane = || Plane { fd: fd_raw, offset: 0, stride: stride as i32 };
                    // Pixel (x, y) is R=200, G=y, B=x, A=x+y+1.
                    let pixel = |x: u32, y: u32| [200u8, y as u8, x as u8, (x + y + 1) as u8];
                    let rgba: Vec<u8> = (0..h).flat_map(|y| (0..w).flat_map(move |x| pixel(x, y))).collect();
                    let attrs = image_attributes(fourcc, modifier, w, h, &[plane()]).unwrap();
                    upload(&reader, &attrs, w, h, &rgba);
                    for modifier in [modifier, IMPLICIT_MODIFIER] {
                        let back = reader.read(fourcc, modifier, w, h, &[plane()]).expect("readback").to_vec();
                        assert_eq!(back.len(), rgba.len());
                        for y in 0..h {
                            for x in 0..w {
                                let mut want = pixel(x, y);
                                if !alpha {
                                    want[3] = 255;
                                }
                                let at = ((y * w + x) * 4) as usize;
                                assert_eq!(
                                    back[at..at + 4],
                                    want,
                                    "{fourcc:#x} modifier {modifier:#x} pixel ({x}, {y})"
                                );
                            }
                        }
                    }
                    (gbm.gbm_bo_destroy)(bo);
                }
                (gbm.gbm_device_destroy)(device);
            }
        }

        trait FromRawChecked {
            fn from_raw_fd_checked(fd: i32) -> Self;
        }
        impl FromRawChecked for std::os::fd::OwnedFd {
            fn from_raw_fd_checked(fd: i32) -> Self {
                assert!(fd >= 0, "gbm_bo_get_fd");
                // SAFETY: gbm_bo_get_fd hands us a new fd we now own.
                unsafe { <Self as std::os::fd::FromRawFd>::from_raw_fd(fd) }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plane(fd: i32, offset: u32, stride: i32) -> Plane {
        Plane { fd, offset, stride }
    }

    #[test]
    fn explicit_modifiers_describe_every_plane() {
        let planes = [plane(4, 0, 8192), plane(5, 64, 128)];
        let attrs = image_attributes(XRGB8888, 0x0300_0000_0000_0010, 1920, 1080, &planes).unwrap();
        assert_eq!(&attrs[..6], &[0x3057, 1920, 0x3056, 1080, 0x3271, XRGB8888 as isize]);
        #[rustfmt::skip]
        assert_eq!(&attrs[6..], &[
            0x3272, 4, 0x3273, 0, 0x3274, 8192, 0x3443, 0x10, 0x3444, 0x0300_0000,
            0x3275, 5, 0x3276, 64, 0x3277, 128, 0x3445, 0x10, 0x3446, 0x0300_0000,
            0x3038,
        ]);
    }

    #[test]
    fn modifier_halves_keep_their_bits() {
        // NVIDIA's block-linear modifiers set the top bits of each half.
        let modifier = 0x0300_0000_0060_6015u64 | 0x8000_0000;
        let attrs = image_attributes(ARGB8888, modifier, 8, 8, &[plane(3, 0, 32)]).unwrap();
        let lo = attrs[attrs.iter().position(|a| *a == 0x3443).unwrap() + 1];
        let hi = attrs[attrs.iter().position(|a| *a == 0x3444).unwrap() + 1];
        assert_eq!(lo as i32 as u32 as u64 | (hi as i32 as u32 as u64) << 32, modifier);
    }

    #[test]
    fn the_fourth_plane_uses_the_modifier_extensions_attributes() {
        let planes = [plane(3, 0, 64), plane(4, 0, 64), plane(5, 0, 64), plane(6, 0, 64)];
        let attrs = image_attributes(XRGB8888, 0, 16, 16, &planes).unwrap();
        let tail = &attrs[attrs.len() - 11..];
        assert_eq!(tail, &[0x3440, 6, 0x3441, 0, 0x3442, 64, 0x3449, 0, 0x344a, 0, 0x3038]);
    }

    #[test]
    fn implicit_modifier_omits_modifier_attributes() {
        let attrs = image_attributes(ARGB8888, IMPLICIT_MODIFIER, 16, 16, &[plane(4, 0, 64)]).unwrap();
        assert_eq!(&attrs[6..], &[0x3272, 4, 0x3273, 0, 0x3274, 64, 0x3038]);
    }

    #[test]
    fn unusable_planes_describe_no_image() {
        assert!(image_attributes(XRGB8888, 0, 16, 16, &[]).is_none());
        assert!(image_attributes(XRGB8888, 0, 16, 16, &[plane(-1, 0, 64)]).is_none());
        assert!(image_attributes(XRGB8888, 0, 16, 16, &[plane(4, 0, 0)]).is_none());
        assert!(image_attributes(XRGB8888, 0, 16, 16, &[plane(4, u32::MAX, 64)]).is_none());
        let five: Vec<_> = (0..5).map(|fd| plane(fd, 0, 64)).collect();
        assert!(image_attributes(XRGB8888, 0, 16, 16, &five).is_none());
    }

    #[test]
    fn modifiers_skip_external_only_and_end_with_implicit() {
        let reported = [(0x0300_0000_0060_6015, false), (0, false), (0x0100_0000_0000_0001, true)];
        assert_eq!(usable_modifiers(reported), [0x0300_0000_0060_6015, 0, IMPLICIT_MODIFIER]);
    }

    #[test]
    fn modifiers_are_listed_once() {
        let reported = [(0, false), (IMPLICIT_MODIFIER, false), (0, false), (IMPLICIT_MODIFIER, true)];
        assert_eq!(usable_modifiers(reported), [0, IMPLICIT_MODIFIER]);
    }

    #[test]
    fn a_driver_without_the_modifier_query_offers_the_implicit_layout() {
        assert_eq!(usable_modifiers([]), [IMPLICIT_MODIFIER]);
    }
}

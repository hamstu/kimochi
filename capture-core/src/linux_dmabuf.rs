//! Import PipeWire DMA-BUFs through the compositor's EGL driver and read back RGBA.

use libloading::Library;
use std::ffi::{c_char, c_void, CStr};
use std::ptr::{null, null_mut};
use wayland_client::Connection;

const EGL_EXTENSIONS: i32 = 0x3055;
const EGL_LINUX_DMA_BUF: u32 = 0x3270;
const EGL_NONE: i32 = 0x3038;
const EGL_OPENGL_ES_API: u32 = 0x30a0;
const EGL_PLATFORM_WAYLAND: u32 = 0x31d8;
pub(crate) const IMPLICIT_MODIFIER: u64 = 0x00ff_ffff_ffff_ffff;
pub(crate) const XRGB8888: u32 = u32::from_le_bytes(*b"XR24");
pub(crate) const ARGB8888: u32 = u32::from_le_bytes(*b"AR24");

const GL_TEXTURE_2D: u32 = 0x0de1;
const GL_FRAMEBUFFER: u32 = 0x8d40;
const GL_COLOR_ATTACHMENT0: u32 = 0x8ce0;
const GL_FRAMEBUFFER_COMPLETE: u32 = 0x8cd5;
const GL_RGBA: u32 = 0x1908;
const GL_UNSIGNED_BYTE: u32 = 0x1401;

type Handle = *mut c_void;
type Proc = unsafe extern "C" fn();
type QueryModifiers = unsafe extern "C" fn(Handle, i32, i32, *mut u64, *mut u32, *mut i32) -> u32;

macro_rules! api {
    ($name:ident { $($symbol:ident: fn($($arg:ty),*) $(-> $ret:ty)?),* $(,)? }) => {
        #[allow(non_snake_case)]
        struct $name {
            $($symbol: unsafe extern "C" fn($($arg),*) $(-> $ret)?,)*
        }
        impl $name {
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

struct Display {
    egl: Egl,
    display: Handle,
    context: Handle,
    _connection: Connection,
    _library: Library,
}

impl Drop for Display {
    fn drop(&mut self) {
        // The context and all calls are confined to the PipeWire loop thread.
        unsafe {
            let d = self.display;
            if !self.context.is_null() {
                (self.egl.eglMakeCurrent)(d, null_mut(), null_mut(), null_mut());
                (self.egl.eglDestroyContext)(d, self.context);
            }
            (self.egl.eglTerminate)(d);
        }
    }
}

pub(crate) struct Reader {
    display: Display,
    gl: Gl,
    query_modifiers: Option<QueryModifiers>,
    pixels: Vec<u8>,
}

fn has_extension(extensions: *const c_char, name: &str) -> bool {
    // EGL and GL own these null-terminated strings for the lifetime of the current display/context.
    !extensions.is_null()
        && unsafe { CStr::from_ptr(extensions) }.to_str().is_ok_and(|list| list.split_whitespace().any(|s| s == name))
}

impl Reader {
    pub(crate) fn new() -> Option<Self> {
        let connection = Connection::connect_to_env().ok()?;
        // Load the host's EGL at runtime, so SHM capture does not depend on a GPU driver.
        unsafe {
            let library = Library::new("libEGL.so.1").ok()?;
            let get_proc =
                *library.get::<unsafe extern "C" fn(*const c_char) -> Option<Proc>>(b"eglGetProcAddress").ok()?;
            let egl = Egl::load(|name| library.get::<Proc>(name.to_bytes_with_nul()).ok().map(|symbol| *symbol))?;
            let display =
                (egl.eglGetPlatformDisplay)(EGL_PLATFORM_WAYLAND, connection.backend().display_ptr().cast(), null());
            if display.is_null() || (egl.eglInitialize)(display, null_mut(), null_mut()) == 0 {
                return None;
            }
            let mut display = Display { egl, display, context: null_mut(), _connection: connection, _library: library };
            let d = display.display;
            let egl = &display.egl;
            let extensions = (egl.eglQueryString)(d, EGL_EXTENSIONS);
            if !has_extension(extensions, "EGL_EXT_image_dma_buf_import")
                || !has_extension(extensions, "EGL_KHR_surfaceless_context")
                || (egl.eglBindAPI)(EGL_OPENGL_ES_API) == 0
            {
                return None;
            }
            let mut config = null_mut();
            let mut count = 0;
            // EGL_SURFACE_TYPE = 0 accepts a window-only config for a surfaceless context.
            let attrs = [0x3033, 0, 0x3040, 4, EGL_NONE]; // EGL_RENDERABLE_TYPE = EGL_OPENGL_ES2_BIT
            if (egl.eglChooseConfig)(d, attrs.as_ptr(), &mut config, 1, &mut count) == 0 || count == 0 {
                return None;
            }
            let attrs = [0x3098, 2, EGL_NONE]; // EGL_CONTEXT_CLIENT_VERSION
            display.context = (egl.eglCreateContext)(d, config, null_mut(), attrs.as_ptr());
            if display.context.is_null() || (egl.eglMakeCurrent)(d, null_mut(), null_mut(), display.context) == 0 {
                return None;
            }
            let gl = Gl::load(|name| get_proc(name.as_ptr()))?;
            if !has_extension((gl.glGetString)(0x1f03).cast(), "GL_OES_EGL_image") {
                return None;
            }
            let query_modifiers = if has_extension(extensions, "EGL_EXT_image_dma_buf_import_modifiers") {
                get_proc(c"eglQueryDmaBufModifiersEXT".as_ptr()).map(|p| std::mem::transmute::<Proc, QueryModifiers>(p))
            } else {
                None
            };
            Some(Self { display, gl, query_modifiers, pixels: Vec::new() })
        }
    }

    pub(crate) fn modifiers(&self, fourcc: u32) -> Vec<u64> {
        let mut supported = Vec::new();
        if let Some(query) = self.query_modifiers {
            let d = self.display.display;
            let mut count = 0;
            // EGL writes at most count entries into each allocation.
            unsafe {
                if query(d, fourcc as i32, 0, null_mut(), null_mut(), &mut count) != 0 && count > 0 {
                    let mut modifiers = vec![0; count as usize];
                    let mut external_only = vec![0; count as usize];
                    if query(d, fourcc as i32, count, modifiers.as_mut_ptr(), external_only.as_mut_ptr(), &mut count)
                        != 0
                    {
                        supported.extend(modifiers.into_iter().zip(external_only).take(count as usize).filter_map(
                            |(modifier, external)| (external == 0 && modifier != IMPLICIT_MODIFIER).then_some(modifier),
                        ));
                    }
                }
            }
        }
        // Older producers can offer only the driver's implicit layout.
        supported.push(IMPLICIT_MODIFIER);
        supported
    }

    pub(crate) fn read(
        &mut self,
        fourcc: u32,
        modifier: u64,
        width: u32,
        height: u32,
        planes: &[Plane],
    ) -> Option<&[u8]> {
        let attrs = image_attributes(fourcc, modifier, width, height, planes)?;
        let Display { egl, display: d, .. } = &self.display;
        let gl = &self.gl;
        // Plane FDs are borrowed from the dequeued PipeWire buffer. glReadPixels finishes the
        // readback and we release the imported image before that buffer is returned.
        unsafe {
            let image = (egl.eglCreateImage)(*d, null_mut(), EGL_LINUX_DMA_BUF, null_mut(), attrs.as_ptr());
            if image.is_null() {
                return None;
            }
            let mut texture = 0;
            let mut fb = 0;
            (gl.glGenTextures)(1, &mut texture);
            (gl.glBindTexture)(GL_TEXTURE_2D, texture);
            (gl.glEGLImageTargetTexture2DOES)(GL_TEXTURE_2D, image);
            (gl.glGenFramebuffers)(1, &mut fb);
            (gl.glBindFramebuffer)(GL_FRAMEBUFFER, fb);
            (gl.glFramebufferTexture2D)(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0);
            let mut ok =
                (gl.glGetError)() == 0 && (gl.glCheckFramebufferStatus)(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE;
            if ok {
                self.pixels.resize((width as usize) * (height as usize) * 4, 0);
                (gl.glReadPixels)(
                    0,
                    0,
                    width as i32,
                    height as i32,
                    GL_RGBA,
                    GL_UNSIGNED_BYTE,
                    self.pixels.as_mut_ptr().cast(),
                );
                ok = (gl.glGetError)() == 0;
            }
            (gl.glDeleteFramebuffers)(1, &fb);
            (gl.glDeleteTextures)(1, &texture);
            (egl.eglDestroyImage)(*d, image);
            ok.then_some(self.pixels.as_slice())
        }
    }
}

pub(crate) struct Plane {
    pub(crate) fd: i32,
    pub(crate) offset: u32,
    pub(crate) stride: i32,
}

fn image_attributes(fourcc: u32, modifier: u64, width: u32, height: u32, planes: &[Plane]) -> Option<Vec<isize>> {
    // EGL_WIDTH, EGL_HEIGHT, EGL_LINUX_DRM_FOURCC_EXT
    let mut attrs = vec![0x3057, width as isize, 0x3056, height as isize, 0x3271, fourcc as isize];
    if planes.is_empty() || planes.len() > 4 {
        return None;
    }
    for (index, plane) in planes.iter().enumerate() {
        if plane.fd < 0 || plane.stride <= 0 || plane.offset > i32::MAX as u32 {
            return None;
        }
        let fd_attr = [0x3272, 0x3275, 0x3278, 0x3440][index];
        attrs.extend([
            fd_attr,
            plane.fd as isize,
            fd_attr + 1,
            plane.offset as isize,
            fd_attr + 2,
            plane.stride as isize,
        ]);
        if modifier != IMPLICIT_MODIFIER {
            let lo_attr = 0x3443 + 2 * index as isize;
            attrs.extend([lo_attr, modifier as i32 as isize, lo_attr + 1, (modifier >> 32) as i32 as isize]);
        }
    }
    attrs.push(EGL_NONE as isize);
    Some(attrs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_modifiers_describe_every_plane() {
        let p = |fd, offset, stride| Plane { fd, offset, stride };
        let attrs =
            image_attributes(XRGB8888, 0x0300_0000_0000_0010, 1920, 1080, &[p(4, 0, 8192), p(5, 64, 128)]).unwrap();
        assert_eq!(
            &attrs[6..],
            &[
                0x3272,
                4,
                0x3273,
                0,
                0x3274,
                8192,
                0x3443,
                16,
                0x3444,
                0x0300_0000,
                0x3275,
                5,
                0x3276,
                64,
                0x3277,
                128,
                0x3445,
                16,
                0x3446,
                0x0300_0000,
                0x3038,
            ]
        );
    }

    #[test]
    fn implicit_modifier_omits_modifier_attributes() {
        let plane = Plane { fd: 4, offset: 0, stride: 64 };
        let attrs = image_attributes(ARGB8888, IMPLICIT_MODIFIER, 16, 16, &[plane]).unwrap();
        assert_eq!(&attrs[6..], &[0x3272, 4, 0x3273, 0, 0x3274, 64, 0x3038]);
    }
}

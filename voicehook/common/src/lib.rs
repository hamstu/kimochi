//! COM layouts shared by the hook and the fixture: DirectSound and XAudio2 (2.7, 2.8, 2.9)
//! vtable slots, GUIDs and the packed structs. Only what the harness touches.
#![allow(non_snake_case, non_camel_case_types, clippy::upper_case_acronyms, clippy::missing_safety_doc)]
use std::ffi::c_void;

pub type HRESULT = i32;
pub const E_FAIL: HRESULT = 0x8000_4005u32 as i32;

#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, Default)]
pub struct GUID {
    pub data1: u32,
    pub data2: u16,
    pub data3: u16,
    pub data4: [u8; 8],
}

impl GUID {
    pub const fn from_u128(v: u128) -> Self {
        Self {
            data1: (v >> 96) as u32,
            data2: (v >> 80) as u16,
            data3: (v >> 64) as u16,
            data4: (v as u64).to_be_bytes(),
        }
    }
}

pub const IID_IDIRECTSOUND: GUID = GUID::from_u128(0x279afa83_4981_11ce_a521_0020af0be560);
pub const IID_IDIRECTSOUND8: GUID = GUID::from_u128(0xc50a7e93_f395_4834_9ef6_7fa99de50966);
pub const IID_IDIRECTSOUNDBUFFER: GUID = GUID::from_u128(0x279afa85_4981_11ce_a521_0020af0be560);
pub const IID_IDIRECTSOUNDBUFFER8: GUID = GUID::from_u128(0x6825a449_7524_4d82_920f_50e36ab3ab1e);
/// XAudio2 2.7 (DirectX SDK June 2010), created through COM.
pub const CLSID_XAUDIO2_7: GUID = GUID::from_u128(0x5a508685_a254_4fba_9b82_9a24b00306af);
pub const IID_IXAUDIO2_7: GUID = GUID::from_u128(0x8bcf1f58_9fe7_4583_8ac6_e2adc465c8bb);

pub const WAVE_FORMAT_PCM: u16 = 1;
pub const WAVE_FORMAT_ADPCM: u16 = 2;
pub const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
pub const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

/// `mmreg.h` packs it to 1 byte (18 bytes, then `cbSize` extra bytes).
#[repr(C, packed(1))]
#[derive(Clone, Copy, Default, Debug)]
pub struct WAVEFORMATEX {
    pub wFormatTag: u16,
    pub nChannels: u16,
    pub nSamplesPerSec: u32,
    pub nAvgBytesPerSec: u32,
    pub nBlockAlign: u16,
    pub wBitsPerSample: u16,
    pub cbSize: u16,
}

impl WAVEFORMATEX {
    pub fn pcm(channels: u16, rate: u32, bits: u16) -> Self {
        let align = channels * bits / 8;
        Self {
            wFormatTag: WAVE_FORMAT_PCM,
            nChannels: channels,
            nSamplesPerSec: rate,
            nAvgBytesPerSec: rate * align as u32,
            nBlockAlign: align,
            wBitsPerSample: bits,
            cbSize: 0,
        }
    }
    pub fn bytes(&self) -> Vec<u8> {
        unsafe { std::slice::from_raw_parts(self as *const Self as *const u8, 18).to_vec() }
    }
}

/// A format pointer's bytes: the 18-byte header plus its `cbSize` extra bytes (none for PCM,
/// whose callers may hand over the 16-byte `PCMWAVEFORMAT`).
pub unsafe fn wfx_bytes(p: *const WAVEFORMATEX) -> Vec<u8> {
    if p.is_null() {
        return Vec::new();
    }
    let w = std::ptr::read_unaligned(p);
    if w.wFormatTag == WAVE_FORMAT_PCM {
        let mut b = std::slice::from_raw_parts(p as *const u8, 16).to_vec();
        b.extend_from_slice(&[0, 0]);
        return b;
    }
    let extra = (w.cbSize as usize).min(1024);
    std::slice::from_raw_parts(p as *const u8, 18 + extra).to_vec()
}

/// A parsed format. `kind` is the effective tag (EXTENSIBLE resolved through its sub-format).
#[derive(Clone, Copy, Debug, Default)]
pub struct Fmt {
    pub tag: u16,
    pub kind: u16,
    pub channels: u16,
    pub rate: u32,
    pub avg_bytes: u32,
    pub block_align: u16,
    pub bits: u16,
}

impl Fmt {
    pub fn parse(b: &[u8]) -> Option<Fmt> {
        if b.len() < 16 {
            return None;
        }
        let u16_at = |i: usize| u16::from_le_bytes([b[i], b[i + 1]]);
        let u32_at = |i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        let tag = u16_at(0);
        // WAVEFORMATEXTENSIBLE: Samples(2) ChannelMask(4) SubFormat(16) after the 18-byte header;
        // the sub-format GUID's first two bytes are the plain tag.
        let kind = if tag == WAVE_FORMAT_EXTENSIBLE && b.len() >= 18 + 22 { u16_at(18 + 6) } else { tag };
        Some(Fmt {
            tag,
            kind,
            channels: u16_at(2),
            rate: u32_at(4),
            avg_bytes: u32_at(8),
            block_align: u16_at(12),
            bits: u16_at(14),
        })
    }
    pub fn is_linear(&self) -> bool {
        self.kind == WAVE_FORMAT_PCM || self.kind == WAVE_FORMAT_IEEE_FLOAT
    }
    pub fn summary(&self) -> String {
        let k = match self.kind {
            WAVE_FORMAT_PCM => format!("pcm{}", self.bits),
            WAVE_FORMAT_IEEE_FLOAT => format!("float{}", self.bits),
            WAVE_FORMAT_ADPCM => "msadpcm".into(),
            0x0161 | 0x0162 => "xwma".into(),
            0x0166 => "xma2".into(),
            t => format!("tag{t:#06x}"),
        };
        format!("{k} {}ch {}Hz", self.channels, self.rate)
    }
    pub fn seconds(&self, bytes: usize) -> f64 {
        if self.avg_bytes == 0 {
            0.0
        } else {
            bytes as f64 / self.avg_bytes as f64
        }
    }
}

#[repr(C)]
#[allow(non_snake_case)]
pub struct DSBCAPS {
    pub dwSize: u32,
    pub dwFlags: u32,
    pub dwBufferBytes: u32,
    pub dwUnlockTransferRate: u32,
    pub dwPlayCpuOverhead: u32,
}

#[repr(C)]
#[allow(non_snake_case)]
pub struct DSBUFFERDESC {
    pub dwSize: u32,
    pub dwFlags: u32,
    pub dwBufferBytes: u32,
    pub dwReserved: u32,
    pub lpwfxFormat: *const WAVEFORMATEX,
    pub guid3DAlgorithm: GUID,
}

/// `xaudio2.h` packs everything to 1 byte.
#[repr(C, packed(1))]
#[derive(Clone, Copy)]
pub struct XAUDIO2_BUFFER {
    pub Flags: u32,
    pub AudioBytes: u32,
    pub pAudioData: *const u8,
    pub PlayBegin: u32,
    pub PlayLength: u32,
    pub LoopBegin: u32,
    pub LoopLength: u32,
    pub LoopCount: u32,
    pub pContext: *mut c_void,
}

#[repr(C, packed(1))]
pub struct XAUDIO2_VOICE_SENDS {
    pub SendCount: u32,
    pub pSends: *const c_void,
}

/// DirectSound vtable slots and flags.
pub mod ds {
    pub const QUERY_INTERFACE: usize = 0;
    pub const RELEASE: usize = 2;
    // IDirectSound / IDirectSound8
    pub const CREATE_SOUND_BUFFER: usize = 3;
    pub const DUPLICATE_SOUND_BUFFER: usize = 5;
    pub const SET_COOPERATIVE_LEVEL: usize = 6;
    // IDirectSoundBuffer / IDirectSoundBuffer8
    pub const GET_CAPS: usize = 3;
    pub const GET_CURRENT_POSITION: usize = 4;
    pub const GET_FORMAT: usize = 5;
    pub const GET_STATUS: usize = 9;
    pub const LOCK: usize = 11;
    pub const PLAY: usize = 12;
    pub const SET_CURRENT_POSITION: usize = 13;
    pub const SET_VOLUME: usize = 15;
    pub const STOP: usize = 18;
    pub const UNLOCK: usize = 19;

    pub const DSSCL_PRIORITY: u32 = 2;
    pub const DSBCAPS_PRIMARYBUFFER: u32 = 0x1;
    pub const DSBCAPS_STATIC: u32 = 0x2;
    pub const DSBCAPS_CTRL3D: u32 = 0x10;
    pub const DSBCAPS_CTRLFREQUENCY: u32 = 0x20;
    pub const DSBCAPS_CTRLPAN: u32 = 0x40;
    pub const DSBCAPS_CTRLVOLUME: u32 = 0x80;
    pub const DSBCAPS_CTRLFX: u32 = 0x200;
    pub const DSBCAPS_GLOBALFOCUS: u32 = 0x8000;
    pub const DSBCAPS_GETCURRENTPOSITION2: u32 = 0x10000;
    pub const DSBPLAY_LOOPING: u32 = 0x1;
    pub const DSBLOCK_ENTIREBUFFER: u32 = 0x2;
}

/// XAudio2 vtable slots. 2.7 has `GetDeviceCount`, `GetDeviceDetails` and `Initialize` before
/// `RegisterForCallbacks`; 2.8 and 2.9 dropped them. Voices are not COM objects (no IUnknown).
pub mod xa {
    pub const ENGINE_RELEASE: usize = 2;
    pub const INITIALIZE_27: usize = 5;
    pub const fn create_source_voice(v27: bool) -> usize {
        if v27 {
            8
        } else {
            5
        }
    }
    pub const fn create_mastering_voice(v27: bool) -> usize {
        if v27 {
            10
        } else {
            7
        }
    }
    pub const GET_VOICE_DETAILS: usize = 0;
    pub const DESTROY_VOICE: usize = 18;
    pub const START: usize = 19;
    pub const STOP: usize = 20;
    pub const SUBMIT_SOURCE_BUFFER: usize = 21;
    pub const FLUSH_SOURCE_BUFFERS: usize = 22;

    pub const END_OF_STREAM: u32 = 0x40;
    pub const LOOP_INFINITE: u32 = 255;
    pub const DEFAULT_PROCESSOR: u32 = 1;
}

/// The function in slot `idx` of `obj`'s vtable.
#[inline]
pub unsafe fn slot(obj: *mut c_void, idx: usize) -> usize {
    *(*(obj as *const *const usize)).add(idx)
}

/// Call slot `idx` of `obj`'s vtable: `vcall!(obj, idx, fn(u32) -> HRESULT, 5)`.
#[macro_export]
macro_rules! vcall {
    ($obj:expr, $idx:expr, fn($($t:ty),*) -> $r:ty $(, $a:expr)*) => {{
        let o: *mut ::std::ffi::c_void = $obj as *mut ::std::ffi::c_void;
        let f: unsafe extern "system" fn(*mut ::std::ffi::c_void $(, $t)*) -> $r =
            ::std::mem::transmute($crate::slot(o, $idx));
        f(o $(, $a)*)
    }};
}

/// FNV-1a, for comparing PCM without a hashing dependency.
pub fn fnv64(b: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for &x in b {
        h ^= x as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Trailing digital silence (exact zero bytes) cut off, as the hook does to clips.
pub fn trim_zeros(b: &[u8]) -> &[u8] {
    let end = b.iter().rposition(|&x| x != 0).map_or(0, |i| i + 1);
    &b[..end]
}

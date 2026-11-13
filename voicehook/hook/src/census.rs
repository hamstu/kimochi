//! Which audio libraries the game has loaded: the first scan logs every module (to identify the
//! engine), later scans only new ones. Audio-related ones also go to events.jsonl, so a capture
//! says which adapter a game needs when DirectSound and XAudio2 saw nothing.
use crate::sink::{self, Ev};
use crate::util::{from_wide, lock, log};
use serde_json::json;
use std::collections::HashSet;
use std::sync::{LazyLock, Mutex};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W, TH32CS_SNAPMODULE,
};

static SEEN: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

const AUDIO: &[&str] = &[
    "dsound",
    "xaudio",
    "x3daudio",
    "xapofx",
    "audioses",
    "mmdevapi",
    "winmm",
    "fmod",
    "cri",
    "adx",
    "atom",
    "wwise",
    "aksound",
    "bass",
    "openal",
    "soft_oal",
    "sdl",
    "mss32",
    "mss64",
    "binkw",
    "vorbis",
    "ogg",
    "opus",
    "avcodec",
    "avformat",
    "mf.dll",
    "mfplat",
    "mfreadwrite",
    "quartz",
    "msacm",
    "audio",
    "sound",
    "wasapi",
    "steamaudio",
    "phonon",
    "resonance",
    "unityplayer",
    "gameassembly",
    "mono",
    "renpy",
    "python",
    "kirikiri",
    "krkr",
    "nwjs",
    "node",
    "libcef",
    "chrome_elf",
];

fn audio_related(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    AUDIO.iter().any(|a| n.contains(a))
}

pub fn scan() {
    let mut names = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, 0);
        if snap == INVALID_HANDLE_VALUE {
            return;
        }
        let mut e: MODULEENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<MODULEENTRY32W>() as u32;
        if Module32FirstW(snap, &mut e) != 0 {
            loop {
                names.push(from_wide(&e.szModule));
                if Module32NextW(snap, &mut e) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    let mut seen = lock(&SEEN);
    let first = seen.is_empty();
    let added: Vec<String> = names.into_iter().filter(|n| seen.insert(n.to_ascii_lowercase())).collect();
    drop(seen);
    if added.is_empty() {
        return;
    }
    if first {
        log(&format!("modules at start: {}", added.join(", ")));
    } else {
        log(&format!("modules loaded: {}", added.join(", ")));
    }
    let audio: Vec<&String> = added.iter().filter(|n| audio_related(n)).collect();
    if !audio.is_empty() {
        sink::send(Ev::Note(json!({"ev": "modules", "audio": audio, "first": first})));
    }
}

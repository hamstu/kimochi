//! CRI ADX2 (CRIWARE Atom), as Unity games link it (`cri_ware_unity.dll`): each `CriAtomExPlayer`'s
//! own sound, before CRI mixes them, so the voice player's lines come out without music or
//! effects.
//!
//! How: CRI decodes and mixes in its own code and hands the mix to Windows, so no audio API sees a
//! voice on its own. CRI's Output Analyzer (what CRIWARE's lip sync uses) captures the PCM of the
//! player it is attached to. The player calls are hooked (`criAtomExPlayer_Start`/`Stop`, the cue
//! setters); the first time a player starts, an analyzer with PCM capture is created and attached to
//! it, and the game's own player calls drain every analyzer's captured PCM
//! (`ExecuteQueuedPcmCapturerCallbacks`; `GetStatus`, which games poll, at most every 20 ms) into a
//! stream per player, which `Start` and `Stop` cut into clips named for their cue.
//!
//! The game's scripts reach CRI through P/Invoke: the export is looked up with `GetProcAddress`
//! (hooked, see `iat`) the first time, and the address kept. Attached to a running game, those kept
//! addresses are repointed in GameAssembly's (IL2CPP) writable data, as in `il2cpp.rs`.
use crate::iat::{self, Hook};
use crate::sink::{self, Ev};
use crate::util::{guard, hex, lock, log};
use serde_json::json;
use std::collections::HashMap;
use std::ffi::{c_char, c_void, CStr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{LazyLock, Mutex, OnceLock};
use windows_sys::Win32::Foundation::HMODULE;

type P = *mut c_void;

static O_START: AtomicUsize = AtomicUsize::new(0);
static O_STOP: AtomicUsize = AtomicUsize::new(0);
static O_SET_CUE_NAME: AtomicUsize = AtomicUsize::new(0);
static O_SET_CUE_ID: AtomicUsize = AtomicUsize::new(0);
static O_DESTROY: AtomicUsize = AtomicUsize::new(0);
static O_GET_STATUS: AtomicUsize = AtomicUsize::new(0);
/// When the analyzers were last drained (ms), so polling calls drain at most every `DRAIN_MS`.
static LAST_DRAIN: Mutex<f64> = Mutex::new(0.0);
const DRAIN_MS: f64 = 20.0;

/// `CriAtomExOutputAnalyzerConfig` as CRIWARE Unity marshals it: four `CriBool`s and two counts.
#[repr(C)]
struct AnalyzerConfig {
    enable_level_meter: i32,
    enable_spectrum_analyzer: i32,
    enable_pcm_capture: i32,
    enable_pcm_capture_callback: i32,
    num_spectrum_analyzer_bands: i32,
    num_captured_pcm_samples: i32,
}

type PcmCapture = unsafe extern "C" fn(*const f32, *const f32, i32, i32);

struct Api {
    analyzer_create: unsafe extern "C" fn(*const AnalyzerConfig, P, i32) -> P,
    analyzer_attach: unsafe extern "C" fn(P, P),
    analyzer_drain: unsafe extern "C" fn(P, PcmCapture),
}

unsafe impl Send for Api {}
unsafe impl Sync for Api {}

static API: OnceLock<Api> = OnceLock::new();

/// A player we watch: its analyzer, and the cue it was last given.
struct Player {
    analyzer: usize,
    cue: Option<String>,
    samples: u64,
    first_data: Option<f64>,
    rate_logged: bool,
}

static PLAYERS: LazyLock<Mutex<HashMap<usize, Player>>> = LazyLock::new(Default::default);
static DRAINING: AtomicUsize = AtomicUsize::new(0);
/// The mixer rate measured on the first player that played a while (0 until then).
static MEASURED: AtomicUsize = AtomicUsize::new(0);
/// Players in the order they first played: each is a channel of its own, so the classifier judges
/// the voice player apart from the music and effects players.
static NEXT_CHANNEL: AtomicUsize = AtomicUsize::new(0);

/// CRI's mixer rate until measured: it follows the output device (44.1 or 48 kHz).
const RATE: u32 = 48000;

/// The mixer rate a player delivered at, when it played the whole time it was timed: within 3% of
/// 44.1 or 48 kHz. A player that was silent for part of it delivered less, and says nothing.
fn standard_rate(per_second: f64) -> Option<u32> {
    [44100u32, 48000].into_iter().find(|&r| (per_second - r as f64).abs() <= r as f64 * 0.03)
}
/// PCM an analyzer keeps between drains: five seconds.
const CAPTURE_SAMPLES: i32 = (RATE * 5) as i32;

const DLL: &str = "cri_ware_unity";

fn hooks() -> [(&'static str, usize, &'static AtomicUsize); 6] {
    [
        ("criAtomExPlayer_Start", start as *const () as usize, &O_START),
        ("criAtomExPlayer_Stop", stop as *const () as usize, &O_STOP),
        ("criAtomExPlayer_SetCueName", set_cue_name as *const () as usize, &O_SET_CUE_NAME),
        ("criAtomExPlayer_SetCueId", set_cue_id as *const () as usize, &O_SET_CUE_ID),
        ("criAtomExPlayer_Destroy", destroy as *const () as usize, &O_DESTROY),
        ("criAtomExPlayer_GetStatus", get_status as *const () as usize, &O_GET_STATUS),
    ]
}

pub fn register() {
    for (name, hook, orig) in hooks() {
        iat::register(Hook { dll: DLL, name, hook, orig });
    }
}

fn key(player: usize) -> sink::Key {
    (10, player)
}

/// The first time cri_ware_unity.dll is seen: the analyzer API, and the player functions already
/// looked up by the game repointed at our hooks.
pub fn on_cri(m: HMODULE, name: &str) {
    if API.get().is_some() {
        return;
    }
    let api = unsafe {
        let f = |n: &CStr| crate::iat::real_gpa(m, n);
        let (c, a, d) = (f(c"criAtomExOutputAnalyzer_Create"), f(c"criAtomExOutputAnalyzer_AttachExPlayer"), f(c"criAtomExOutputAnalyzer_ExecuteQueuedPcmCapturerCallbacks"));
        if c == 0 || a == 0 || d == 0 {
            log(&format!("cri: {name} has no output analyzer; adapter off"));
            return;
        }
        Api { analyzer_create: std::mem::transmute(c), analyzer_attach: std::mem::transmute(a), analyzer_drain: std::mem::transmute(d) }
    };
    let _ = API.set(api);
    log(&format!("cri: output analyzer found in {name}"));
    // Calls the game's code already looked up: their addresses, kept in GameAssembly's data.
    let game = unsafe { windows_sys::Win32::System::LibraryLoader::GetModuleHandleA(c"GameAssembly.dll".as_ptr().cast()) };
    let data = if game.is_null() { Vec::new() } else { unsafe { crate::il2cpp::writable_sections(game as usize) } };
    for (fname, hook, orig) in hooks() {
        let cname = std::ffi::CString::new(fname).unwrap();
        let real = unsafe { crate::iat::real_gpa(m, &cname) };
        if real == 0 {
            continue;
        }
        let _ = orig.compare_exchange(0, real, Ordering::SeqCst, Ordering::SeqCst);
        if orig.load(Ordering::SeqCst) != real {
            continue;
        }
        let copies: usize = data.iter().map(|&(s, l)| unsafe { crate::il2cpp::repoint_all(s, l, real, hook) }).sum();
        if copies > 0 {
            log(&format!("cri: {fname}: {copies} kept addresses repointed"));
        }
    }
    sink::send(Ev::Note(json!({"ev": "adapter", "adapter": "cri", "module": name})));
}

/// The player's analyzer, created and attached the first time it plays.
unsafe fn watch(player: usize) {
    let Some(api) = API.get() else { return };
    // Marked as being watched, then the lock let go: CRI takes its own lock in the calls below,
    // and the drain thread holds that one while it waits for ours.
    {
        let mut players = lock(&PLAYERS);
        if players.contains_key(&player) {
            return;
        }
        players.insert(player, Player { analyzer: 0, cue: None, samples: 0, first_data: None, rate_logged: true });
    }
    let config = AnalyzerConfig {
        enable_level_meter: 0,
        enable_spectrum_analyzer: 0,
        enable_pcm_capture: 1,
        enable_pcm_capture_callback: 1,
        num_spectrum_analyzer_bands: 0,
        num_captured_pcm_samples: CAPTURE_SAMPLES,
    };
    let analyzer = (api.analyzer_create)(&config, std::ptr::null_mut(), 0) as usize;
    if analyzer == 0 {
        log(&format!("cri: no analyzer for player {}", hex(player)));
        return;
    }
    (api.analyzer_attach)(analyzer as P, player as P);
    let cue = lock(&PENDING_CUES).remove(&player);
    lock(&PLAYERS).insert(player, Player { analyzer, cue, samples: 0, first_data: None, rate_logged: false });
    let rate = match MEASURED.load(Ordering::SeqCst) { 0 => RATE, r => r as u32 };
    let channel = format!("player{}", NEXT_CHANNEL.fetch_add(1, Ordering::SeqCst));
    sink::send(Ev::Create { key: key(player), api: "cri", fmt: crate::unity::float_fmt(2, rate), info: json!({"analyzer": hex(analyzer), "channel": channel}) });
    lock(&CHANNELS).insert(player, channel);
    log(&format!("cri: watching player {} (analyzer {})", hex(player), hex(analyzer)));
}

/// Every analyzer's captured PCM, into its player's stream. Only on the game's own CRI calls
/// (its thread, between its other CRI calls): CRI's analyzer is not called from a thread of ours,
/// which hung a game while it loaded.
unsafe fn drain_due() {
    let now = crate::util::now_ms();
    {
        let mut last = lock(&LAST_DRAIN);
        if now - *last < DRAIN_MS {
            return;
        }
        *last = now;
    }
    drain();
}

unsafe fn drain() {
    let Some(api) = API.get() else { return };
    let list: Vec<(usize, usize)> = lock(&PLAYERS).iter().filter(|(_, p)| p.analyzer != 0).map(|(&k, p)| (k, p.analyzer)).collect();
    for (player, analyzer) in list {
        DRAINING.store(player, Ordering::SeqCst);
        (api.analyzer_drain)(analyzer as P, captured);
    }
    DRAINING.store(0, Ordering::SeqCst);
}

unsafe extern "C" fn captured(left: *const f32, right: *const f32, channels: i32, n: i32) {
    guard(|| unsafe {
        let player = DRAINING.load(Ordering::SeqCst);
        if player == 0 || left.is_null() || n <= 0 {
            return;
        }
        let n = n as usize;
        let l = std::slice::from_raw_parts(left, n);
        let r = if channels >= 2 && !right.is_null() { std::slice::from_raw_parts(right, n) } else { l };
        let mut bytes = Vec::with_capacity(n * 8);
        for i in 0..n {
            bytes.extend_from_slice(&l[i].to_le_bytes());
            bytes.extend_from_slice(&r[i].to_le_bytes());
        }
        let mut players = lock(&PLAYERS);
        if let Some(p) = players.get_mut(&player) {
            let now = crate::util::now_ms();
            // The first drain holds what queued before it (a backlog): timed from after it.
            let Some(first) = p.first_data else {
                p.first_data = Some(now);
                drop(players);
                sink::send(Ev::Data { key: key(player), bytes, eos: false, looping: false, region: None, info: serde_json::Value::Null });
                return;
            };
            p.samples += n as u64;
            // Measured once it has played a while past the backlog its analyzer starts with.
            if !p.rate_logged && now - first > 6_000.0 {
                p.rate_logged = true;
                let per_second = p.samples as f64 * 1000.0 / (now - first);
                log(&format!("cri: player {} gave {per_second:.0} samples/s", hex(player)));
                let Some(rate) = standard_rate(per_second) else { return };
                if MEASURED.compare_exchange(0, rate as usize, Ordering::SeqCst, Ordering::SeqCst).is_ok() && rate != RATE {
                    log(&format!("cri: mixer rate {rate} Hz"));
                    // Players announced before the rate was known: their format again.
                    let channels = lock(&CHANNELS).clone();
                    for (pl, channel) in channels {
                        sink::send(Ev::Create { key: key(pl), api: "cri", fmt: crate::unity::float_fmt(2, rate), info: json!({"channel": channel, "measured": true}) });
                    }
                }
            }
        }
        sink::send(Ev::Data { key: key(player), bytes, eos: false, looping: false, region: None, info: serde_json::Value::Null });
    });
}

unsafe extern "C" fn get_status(player: P) -> i32 {
    guard(|| unsafe { drain_due() });
    let o: unsafe extern "C" fn(P) -> i32 = std::mem::transmute(O_GET_STATUS.load(Ordering::SeqCst));
    o(player)
}

unsafe extern "C" fn start(player: P) -> u32 {
    guard(|| unsafe {
        drain();
        watch(player as usize);
        let cue = lock(&PLAYERS).get(&(player as usize)).and_then(|p| p.cue.clone());
        // Its clips go with the shape of their cue's name (`Yuk_S00sky_000001`: `a_a9a_9`), else
        // the cue sheet they come from: games play each voice line on a player, even a sheet, of
        // its own, and name every voice cue alike.
        let group = cue.as_deref().map(|c| format!("cue:{}", shape(c))).or_else(|| lock(&PLAYER_SHEETS).get(&(player as usize)).cloned());
        if let Some(sheet) = group {
            let changed = lock(&CHANNELS).insert(player as usize, sheet.clone()).as_deref() != Some(sheet.as_str());
            if changed {
                let rate = match MEASURED.load(Ordering::SeqCst) { 0 => RATE, r => r as u32 };
                sink::send(Ev::Create { key: key(player as usize), api: "cri", fmt: crate::unity::float_fmt(2, rate), info: json!({"channel": sheet}) });
            }
        }
        sink::send(Ev::Source { key: key(player as usize), source: cue.clone() });
        sink::send(Ev::Play { key: key(player as usize), looping: false, info: json!({"cue": cue}) });
    });
    let o: unsafe extern "C" fn(P) -> u32 = std::mem::transmute(O_START.load(Ordering::SeqCst));
    o(player)
}

unsafe extern "C" fn stop(player: P) {
    guard(|| unsafe {
        drain();
        sink::send(Ev::Stop { key: key(player as usize) });
    });
    let o: unsafe extern "C" fn(P) = std::mem::transmute(O_STOP.load(Ordering::SeqCst));
    o(player)
}

unsafe extern "C" fn destroy(player: P) {
    guard(|| {
        if lock(&PLAYERS).remove(&(player as usize)).is_some() {
            sink::send(Ev::Destroy { key: key(player as usize) });
        }
    });
    let o: unsafe extern "C" fn(P) = std::mem::transmute(O_DESTROY.load(Ordering::SeqCst));
    o(player)
}

fn set_cue(player: P, cue: String) {
    if let Some(p) = lock(&PLAYERS).get_mut(&(player as usize)) {
        p.cue = Some(cue);
    } else {
        // Not started yet: kept for its first start.
        lock(&PENDING_CUES).insert(player as usize, cue);
    }
}

static PENDING_CUES: LazyLock<Mutex<HashMap<usize, String>>> = LazyLock::new(Default::default);
static CHANNELS: LazyLock<Mutex<HashMap<usize, String>>> = LazyLock::new(Default::default);
/// Cue sheets (ACB handles) in the order first seen, and the sheet each player's cue is from.
static SHEETS: LazyLock<Mutex<HashMap<usize, String>>> = LazyLock::new(Default::default);
static PLAYER_SHEETS: LazyLock<Mutex<HashMap<usize, String>>> = LazyLock::new(Default::default);

/// A cue name's shape: each run of letters `a`, of digits `9`, other characters kept.
fn shape(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        let class = if c.is_ascii_digit() { '9' } else if c.is_alphabetic() { 'a' } else { c };
        if out.chars().last() != Some(class) || !(class == 'a' || class == '9') {
            out.push(class);
        }
    }
    out
}

fn set_sheet(player: P, acb: P) {
    if acb.is_null() {
        return;
    }
    let sheet = {
        let mut sheets = lock(&SHEETS);
        let n = sheets.len();
        sheets.entry(acb as usize).or_insert_with(|| format!("sheet{n}")).clone()
    };
    lock(&PLAYER_SHEETS).insert(player as usize, sheet);
}

unsafe extern "C" fn set_cue_name(player: P, acb: P, name: *const c_char) {
    guard(|| unsafe {
        if !name.is_null() {
            set_cue(player, CStr::from_ptr(name).to_string_lossy().into_owned());
        }
        set_sheet(player, acb);
    });
    let o: unsafe extern "C" fn(P, P, *const c_char) = std::mem::transmute(O_SET_CUE_NAME.load(Ordering::SeqCst));
    o(player, acb, name)
}

unsafe extern "C" fn set_cue_id(player: P, acb: P, id: i32) {
    guard(|| {
        set_cue(player, format!("cue#{id}"));
        set_sheet(player, acb);
    });
    let o: unsafe extern "C" fn(P, P, i32) = std::mem::transmute(O_SET_CUE_ID.load(Ordering::SeqCst));
    o(player, acb, id)
}

#[cfg(test)]
mod tests {
    use super::{shape, standard_rate};

    #[test]
    fn voice_cues_share_a_shape_and_effects_do_not() {
        assert_eq!(shape("Yuk_S00sky_000001"), "a_a9a_9");
        assert_eq!(shape("Kan_S00sky_000124"), shape("Van_S01park_000003"));
        assert_ne!(shape("Common_SE_NoticeWindow_Bye"), shape("Yuk_S00sky_000001"));
        assert_ne!(shape("CharacterStep"), shape("Yuk_S00sky_000001"));
    }

    #[test]
    fn only_a_player_that_played_throughout_gives_the_rate() {
        assert_eq!(standard_rate(43924.0), Some(44100));
        assert_eq!(standard_rate(47410.0), Some(48000));
        // Silent part of the time, or a backlog drained at once.
        assert_eq!(standard_rate(22870.0), None);
        assert_eq!(standard_rate(58089.0), None);
    }
}

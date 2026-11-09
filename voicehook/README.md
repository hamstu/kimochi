# voicehook — voice-line capture test harness

The voice-capture library and its standalone test harness: get each sound a game plays *before* it is
mixed, so a voice line comes out on its own, with no BGM or SFX in it. One injected DLL with an
adapter per audio path, an NW.js page script for HTML5 engines, a shared capture format
(`events.jsonl` + `clips/`), and a classifier that picks the voice and pairs clips with text lines.

| Adapter | Engines it covers | What a clip is | Verified on |
|---|---|---|---|
| DirectSound (vtables) | KiriKiri, SiglusEngine/RealLive, NScripter, older engines | per buffer: PCM as written, cut at stop/release/end | KiriKiri Z (x64 and x86), SiglusEngine (x86) and NScripter (x86) games, fixture |
| XAudio2 2.7/2.8/2.9 (vtables) | AdvHD, newer engines | per source voice: submitted PCM | an AdvHD game (x64), fixture |
| winmm `waveOut*` (imports) | old engines that open a device per sound | per device: written PCM | fixture |
| SDL_mixer (imports) | ONScripter builds with SDL2_mixer.dll, ports | per play: the chunk's decoded PCM + file name | fixture (SDL2_mixer 2.8.0) |
| Unity Mono (internal calls) | Unity 2017-6000 Mono builds | per `AudioSource.Play*`: clip name + PCM (`GetData`) | Unity 6 (x64), 2019 (x86) and 2021.3 (x64) games |
| Ren'Py (embedded Python) | Ren'Py 6/7/8 | per file started on a channel: the original file + channel | Ren'Py 8.5 (voiced) and 8.3 games, fixture |
| Web (page script) | RPG Maker MV/MZ, TyranoScript (howler), `<audio>`, on NW.js or Electron | per play: the original file (RPG Maker audio decrypted) + URL | an RPG Maker MV game (NW.js), a TyranoScript game (Electron) |

Voice clips from these games were checked with `speechcheck` (Kimochi's VAD + SenseVoice): each
transcribes as one clean line, and BGM/SE clips come out at 0 speech.

Not built: CRI ADX2, FMOD, Wwise, WASAPI used directly, Unity IL2CPP, Unity VideoPlayer audio
(voice baked into movies), SDL_mixer linked statically (ONScripter-EN), Electron pages without
Node, native ARM64 games. The module census (below) says when a game needs one of them.

## How it works

- **No code patching.** The COM APIs are hooked by pointing vtable slots at our functions (every
  object of a class shares its vtable, so objects made before an attach are hooked too). Exported
  APIs are hooked in the *callers'* import tables, and `GetProcAddress` is hooked in every
  non-system module so run-time lookups get the hook too (`hook/src/iat.rs`). Both are pointer
  writes, so they work in x64 games emulated on ARM64 Windows, whose system DLLs are ARM64X.
- **Unity**: UnityPlayer registers its engine functions with `mono_add_internal_call`, which it
  looks up through `GetProcAddress`; our wrapper swaps in trampolines for the AudioSource play/stop
  calls. Unity 2019 passes managed objects, Unity 6 native pointers (mapped to managed objects
  through `m_CachedPtr`). Clip name and PCM come from the managed getters via
  `mono_runtime_invoke`. AssetBundle clips not loaded at Play are fetched a moment later.
  Attached to a running game (registration has happened), each function is taken from Mono's
  table and the compiled wrapper that calls it is repointed. Mono's profiler API was tried
  first: it cannot give call arguments to an embedder in Unity's Mono builds.
- **Ren'Py**: from our thread, with the GIL, a few lines of Python wrap
  `renpy.audio.renpysound.play/queue/stop`; the wrapper reads the exact bytes handed to the mixer
  and passes them to `voicehook_emit` in the DLL via ctypes. Launch or attach.
- **Web**: see [`voicehook web`](#nwjs-games-voicehook-web).
- **Clips** (`hook/src/sink.rs`): streamed adapters (DirectSound, XAudio2, waveOut) keep one
  stream per buffer/voice/device and cut a clip at end of stream, stop, flush, release, a reload of
  a played one-shot, a gap once the pending audio has played out, or when it has played out and
  gone quiet. A DirectSound buffer filled and stopped before it ever played is a primed fill and is
  discarded (SiglusEngine does this for every sound). Whole-clip adapters (SDL_mixer, Unity,
  Ren'Py, web) write a clip per play. Trailing digital silence is trimmed.

## Capture format (the interface the app would consume)

A capture folder holds `voicehook.log` (what was hooked, every module loaded), `events.jsonl`,
and `clips/`. Every adapter writes the same events; times are Unix ms, the clock Kimochi's Log
uses.

```jsonc
{"ev":"stream","s":3,"api":"xaudio2.9","ptr":"0x1bff8640","fmt":"float32 1ch 44100Hz","info":{...}}
{"ev":"clip","seq":12,"s":3,"api":"xaudio2.9","why":"eos","start":1794180962800.1,"dur":4.41,
 "file":"clips/00012_xaudio29_s3_1bff8640.wav","fmt":"float32 1ch 44100Hz","looping":false,
 "streamed":false,"peak":0.95,"rms":0.12,"silent":false,"source":null}
{"ev":"clip","seq":40,"s":7,"api":"renpy","why":"whole","start":...,"dur":2.2,"fmt":"ogg",
 "file":"clips/00040_renpy_s7_l2.ogg","source":"voice/l2.ogg","meta":{"channel":"voice",...}}
```

- `api`: `dsound`, `xaudio2.7/2.9`, `waveout`, `sdl_mixer`, `unity`, `renpy`, `web`.
- `source`: file, cue or clip name where the adapter knows it; `meta`: adapter details (Ren'Py
  channel, Unity method and load type, RPG Maker engine info...).
- `fmt`: a PCM summary for WAV clips, or the container (`ogg`, `opus`, `m4a`...) for original files.
- Other events: `play`, `stop`, `data`, `seek`, `discard`, `replay`, `renpy_loop`, `unity_stop`,
  `modules` (audio-ish DLLs), `adapter` (what got installed).

## Build

```powershell
.\build.ps1          # x64 + x86 into dist\ (rustup targets x86_64- and i686-pc-windows-msvc)
.\fetch-fixture-libs.ps1   # official SDL2 / SDL2_mixer DLLs for the SDL fixture (not committed)
```

Targets are explicit, so an ARM64 host builds the same x64/x86 binaries.
`dist\` holds `voicehook.exe`/`voicehook32.exe`, `voicehook_x64.dll`/`voicehook_x86.dll`,
`vh-fixture.exe`/`vh-fixture32.exe`, `vh-classify.exe`, `selftest.ps1`, `tools\`.

## Self-test

```powershell
.\selftest.ps1                                   # every native scene, both bitnesses
.\selftest.ps1 -RenpyFrom "D:\Games\Some RenPy 8 game"   # plus the Ren'Py fixture
```

Scenes (`vh-fixture play`): `ds` (one-shots, pooled, preloaded, streamed BGM), `dss`
(SiglusEngine/KiriKiri-style stream rings: primed, stopped, refilled per half), `xa9`, `xa8`,
`xa7`, `wo` (waveOut, device per line and shared), `sdl` (SDL2_mixer chunks with file names).
The Ren'Py fixture links an installed Ren'Py 8 engine to a generated `game/` folder.

A line passes when exactly one clip has exactly its bytes, no other clip starts like it (no
duplicate, no fragment), and, where named, the clip's `source` is its file. On Windows 11 ARM64
(x64 emulated): **27/27 per bitness, Ren'Py 3/3**.

## Capturing a game

```powershell
.\voicehook.exe launch "D:\Games\Some VN\game.exe"     # suspended until the hooks are in
.\voicehook.exe ps advhd                               # or attach to a running game
.\voicehook.exe attach AdvHD.exe
.\voicehook.exe report captures\<folder>
.\vh-classify.exe captures\<folder> [lines.jsonl]      # which clips are the voice
```

The 32/64-bit choice is automatic.

### NW.js games (`voicehook web`)

```powershell
.\voicehook.exe web "D:\Games\Some RPG\Game.exe"
.\voicehook.exe web --restore "D:\Games\Some RPG\Game.exe"   # after a crash
```

Shipped NW.js games are mostly "normal" builds with remote debugging compiled out, so instead of
CDP this adds `"inject_js_end": "voicehook-web.js"` to the game's package.json (backup
`package.json.voicehook-bak`, restored when the game exits) and writes the script next to it.
NW.js pages have Node, so the script writes the capture itself. Streams are per RPG Maker folder
(`rpgm:voice`, `rpgm:se`...), per howler or per `<audio>`. A file played again (a loop, a
replayed voice) points at its first copy.

Electron games (`resources\app.asar`, no package.json) are started with
`--remote-debugging-port` and the same script is put into each page over CDP
(`cli/src/cdp.rs`); it needs Node in the page, which TyranoScript's Electron builds have.

## Speech check (`speechcheck/`, `vh-speechcheck`)

Built for the host (it uses Kimochi's `kimochi-speech` crate and the ARM64 ONNX Runtime a
Kimochi install keeps): `cargo run --release -- <capture>` writes `speech.jsonl` (VAD speech share
and SenseVoice text per WAV/Ogg clip). `vh-classify` uses it as its speech check when present.

## Voice classifier (`classify/`, `vh-classify`)

Pure logic over a capture and text-hook lines (`{"uid","text","ts","appeared"?,"ocr"?}`, the
fields of `kimochi_speech::timeline::Line`):
- clips are judged in groups (adapter + format + channel/folder), since many engines open a new
  buffer or voice per sound;
- signals: names and channels (`voice`, `vo_`, `koe`, `ボイス` vs `bgm`, `se_`...), looping, clip
  length, mono, and how often a group's clips start just after a line appears;
- each line gets the nearest voice clip starting 0.4 s before (1.6 s for OCR lines without an
  appearance time) to 1.5 s after its anchor;
- an optional per-clip speech check (`match_lines_with`, `Confirm`) is where Kimochi's VAD /
  SenseVoice plug in.

`vh-classify mock` runs synthetic AdvHD-, Siglus-, Unity-, Ren'Py- and OCR-like scenes: named or
channelled engines are matched perfectly by timing alone; unnamed DirectSound/XAudio2 engines get
~0.83 precision from timing alone and ~0.97 with the speech check.

## Notes for the test machine

- **On ARM64 Windows**, x86 games run on emulated x86 system DLLs; x64 games run emulated against
  ARM64X system DLLs. Both verified (selftest, AdvHD and Unity games, x64).
- With the system locale set to ja-JP, Japanese games need no Locale Emulator.
- `tools\drive.ps1` (screenshots, clicks, keys, window fit) and `tools\advance.ps1` (advance a
  VN and log each advance as a line) drive games for unattended tests.
- **Antivirus** may flag a DLL injector. Run from a folder excluded from scanning if needed.
- Don't use it on games with anti-cheat or online play.

## Layout

- `common/`: COM layouts shared by hook and fixture
- `hook/`: the injected DLL — `ds.rs`, `xa.rs` (COM), `iat.rs` (import/GetProcAddress hooks),
  `waveout.rs`, `sdl.rs`, `unity.rs`, `renpy.rs`, `sink.rs` (clips and events), `census.rs`
- `cli/`: `voicehook launch | attach | report | ps | web`, and `web.js` (the NW.js page script)
- `fixture/`: the scripted scenes, the Ren'Py game writer, and `check`
- `classify/`: the voice classifier and its mock scenes
- `tools/`: game-driving scripts

## Kimochi integration

The Windows app builds `vh-hook` for x86 and x64 and stages both DLLs alongside hookd.
Sentence audio uses the capture reader and matcher in `speech-core/src/hooked/`, preferring
clean clips and retaining the system-audio listener as fallback. App-mode captures go to
`%LOCALAPPDATA%/kimochi-voicehook/<pid>-<time>`; saved clips are limited to 30 seconds each
and bounded by a 128 MiB / 256 clip budget until the game exits. Launch-time web adapters
remain available through the standalone harness, outside automatic app attachment.

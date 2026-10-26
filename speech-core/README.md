# speech-core

Sentence audio's ears: from recorded system audio to the clip of each line's voice. The app
(`src-tauri/src/sentence_audio/`) drives it; so does the lab below, which runs exactly the same
listener outside the app.

- `listener.rs`: follows the recording, hears where speech is (Silero, helped by loudness),
  transcribes it in pause-bounded chunks once the speech model is there, and decides each line's
  voice: matched by its words, placed by timing, no voice, or missed. An OCR scan's lines (a name
  box and the dialogue) are decided together as one voice; a match holds the words it heard, so
  no other line takes them, and is never given up; a line without one is tried again as more is
  transcribed.
- `sense_voice.rs`, `fbank.rs`: SenseVoice-Small on the app's ONNX Runtime (features and
  decoding as sherpa-onnx does them).
- `matching.rs`: a line's text lined up with what was heard, to the character.
- `clips.rs`: clips cut, levelled, encoded and kept; word clips cut out of them.
- `vad.rs`, `trim.rs`, `encode.rs`, `timeline.rs`, `wav.rs`: the parts.

```sh
cargo test --manifest-path speech-core/Cargo.toml
```

## The lab

`speech-lab` measures how well lines get their voice, on a recording, as fast as the computer
can. It needs the app's ONNX Runtime (staged by `npm run prepare:meikiocr` into
`src-tauri/resources/meikiocr/runtime/`, or `KIMOCHI_ORT=<library>`), and uses the speech model
the app downloaded (Settings → Anki → Sentence Audio) unless given `--model <dir>` or
`--no-model`. ffmpeg reads audio and video.

```sh
cargo build --release --manifest-path speech-core/Cargo.toml --bin speech-lab
LAB=speech-core/target/release/speech-lab

# A live session: this computer's audio, with lines typed or piped in (plain text, or JSON rows
# {"text", "ts"?, "source"?, "truth"?}), until stdin closes or --seconds pass.
some-texthooker | $LAB record sessions/live
# A screen recording with sound: frames read the way automatic OCR reads a game.
$LAB video game.mp4 sessions/video --fps 5 --crop 0,520,1280,200
# Voiced lines with known text, laid out as a player clicks through them (hook, typewriter or
# manual OCR, scanned during the voice or after it), optionally under music, with the speaker's
# name box in each scan (--names) and lines read in part before in full (--rereads): the truth is
# known, so the report scores every line, name boxes given a voice, and clips that changed after
# being matched.
$LAB synth dataset.json sessions/synth --mode manual --names --rereads --bgm music.mp3

$LAB replay sessions/synth
open sessions/synth/replay/report.html
```

A session is a folder: `session.json` (`{"audio": "audio.wav", "audioStartMs": …}`), `audio.wav`,
`lines.jsonl` (one line a row: `uid`, `text`, `ts`, `source` `hook` or `ocr`, optional
`appeared`, `scan`, `replaces`, `kind` `name` and `truth` `{voiced, startMs, endMs}`) and optionally `screen.jsonl` (automatic OCR's
quick readings, `{at, text}`). `replay` writes `report.html`, `report.json` (with the summary and,
given the truth, how many clips held the whole voice and how far their ends were off) and
`clips/`; every line says why it was decided as it was (as Diagnostics → Sentence audio does in
the app). `KIMOCHI_SENTENCE_AUDIO_DEBUG=1` prints what each line was decided from.

`vad_probe` (an example) prints Silero's probability and the loudness of every 32 ms of a WAV.

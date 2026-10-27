"""Lab sessions from a recording of a voiced game: what the player read, and when each line's voice
really was, for `speech-lab replay` to score.

    python3 game_video.py VIDEO OUT [--crop x,y,w,h] [--fps 5] [--seed 3]

writes, under OUT:

    audio.wav        the video's sound (mono, 48 kHz), shared by the sessions
    auto/            automatic OCR: each settled screen logged as one scan
    manual/          manual OCR: each new dialogue scanned once, a third of them mid-voice
    cache/           the frame readings and transcripts the above are made from (delete to redo)
    truth.txt        every line with its voice, to check by eye

The screen (cropped to the game's text, as a player would pick the region) is read `--fps` times
a second with MeikiOCR, the app's local OCR, and grouped into blocks as the app groups them (one
Log line per block, the blocks of a scan sharing its id). As in the app, a reading that is the
same twice running is logged as a scan, unless it is a reading already logged (or part of one);
a fuller reading takes the place of the lines it contains.

The truth comes from Whisper (large-v3), transcribing each dialogue's time on screen on its own
(one long transcript drifts and invents lines over music). A line is voiced when most of its
letters line up with what Whisper heard then, and its voice runs from the first of those words
to the last. Whisper's word times are good to about a tenth of a second; `OUT/truth.json` can
correct a line by its text: {"<text>": {"voiced": false}} or {"<text>": {"startS": 1.2, "endS": 3.4}}.

Needs ffmpeg, and Python packages meikiocr, opencv-python-headless, numpy and mlx-whisper (Apple
silicon) or openai-whisper. Run with `python3 -I` from outside OUT.
"""

import argparse
import difflib
import json
import random
import subprocess
import sys
import unicodedata
from pathlib import Path

import numpy as np

T0 = 1_800_000_000_000.0  # the sessions' clock: Unix ms of the video's first sample
SCAN_MS = 400.0  # the accurate scan after the quick reading settles (as `speech-lab video`)
RATE = 48_000
WHISPER_RATE = 16_000
MERGE_WINDOW_S = 60.0  # history_merge.rs: how far back, and how many entries, merging looks
MERGE_DEPTH = 3


def letters(text):
    """The characters that carry a sentence (history_merge.rs), kana folded to hiragana."""
    out = []
    for c in unicodedata.normalize("NFKC", text):
        if c.isalnum() or c == "ー":
            if "ァ" <= c <= "ヶ":
                c = chr(ord(c) - 0x60)
            out.append(c)
    return "".join(out)


# --- reading the screen -------------------------------------------------------------------------


def frames(video, crop, fps):
    x, y, w, h = crop
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"fps={fps},crop={w}:{h}:{x}:{y}",
         "-f", "rawvideo", "-pix_fmt", "bgr24", "-"],
        stdout=subprocess.PIPE,
    )
    size = w * h * 3
    k = 0
    while True:
        data = proc.stdout.read(size)
        if len(data) < size:
            break
        yield k / fps, np.frombuffer(data, np.uint8).reshape(h, w, 3)
        k += 1
    proc.wait()


def blocks(results):
    """MeikiOCR's lines grouped as the app groups them for the Log (ui/ocr-result.ts
    `logicalGroups`): lines in a row close together, or stacked and overlapping."""
    boxes = []
    for r in results:
        text = r["text"].strip()
        if not text or not r["chars"]:
            continue
        xs = [v for ch in r["chars"] for v in (ch["bbox"][0], ch["bbox"][2])]
        ys = [v for ch in r["chars"] for v in (ch["bbox"][1], ch["bbox"][3])]
        boxes.append({"text": text, "box": (min(xs), min(ys), max(xs), max(ys)), "vertical": r["is_vertical"]})
    parent = list(range(len(boxes)))

    def root(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, a in enumerate(boxes):
        for j in range(i + 1, len(boxes)):
            b = boxes[j]
            if a["vertical"] != b["vertical"]:
                continue
            (ax0, ay0, ax1, ay1), (bx0, by0, bx1, by1) = a["box"], b["box"]
            v = a["vertical"]
            em = max(1, min(ax1 - ax0, bx1 - bx0) if v else min(ay1 - ay0, by1 - by0))
            along = max(0, max(ay0, by0) - min(ay1, by1)) if v else max(0, max(ax0, bx0) - min(ax1, bx1))
            cross = max(0, max(ax0, bx0) - min(ax1, bx1)) if v else max(0, max(ay0, by0) - min(ay1, by1))
            aligned = abs((ax0 + ax1) - (bx0 + bx1)) / 2 < em * 0.7 if v else abs((ay0 + ay1) - (by0 + by1)) / 2 < em * 0.7
            overlap = min(ay1, by1) - max(ay0, by0) if v else min(ax1, bx1) - max(ax0, bx0)
            if (aligned and along < em * 1.8) or (overlap > em * 0.5 and cross < em * 0.8):
                parent[root(j)] = root(i)
    groups = {}
    for i in range(len(boxes)):
        groups.setdefault(root(i), []).append(boxes[i])
    out = []
    for members in groups.values():
        members.sort(key=lambda b: (b["box"][1], b["box"][0]))
        out.append({"text": "\n".join(b["text"] for b in members), "y": members[0]["box"][1], "x": members[0]["box"][0]})
    out.sort(key=lambda g: (g["y"], g["x"]))
    return [g["text"] for g in out]


def read_screen(video, crop, fps, cache):
    path = cache / "screen.jsonl"
    if path.exists():
        return [json.loads(l) for l in path.read_text().splitlines()]
    from meikiocr import MeikiOCR

    ocr = MeikiOCR()
    rows = []
    with open(path.with_suffix(".tmp"), "w") as out:
        for t, image in frames(video, crop, fps):
            row = {"t": round(t, 3), "blocks": blocks(ocr.run_ocr(image))}
            rows.append(row)
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            if len(rows) % 100 == 0:
                print(f"  read {t:.0f}s", file=sys.stderr)
    path.with_suffix(".tmp").rename(path)
    return rows


def merge(new, entries, at):
    """history_merge.rs, simplified to exact containment of letters: "skip", the entries the new
    one replaces, or [] to add it."""
    new_letters = letters(" ".join(new))
    recent = [e for e in entries[-MERGE_DEPTH:] if at - e["at"] <= MERGE_WINDOW_S]
    if any(new_letters in letters(" ".join(e["blocks"])) for e in recent):
        return "skip"
    return [e for e in recent if letters(" ".join(e["blocks"])) in new_letters]


def auto_scans(readings):
    """Automatic OCR: a reading the same twice running is scanned, `SCAN_MS` later."""
    entries, previous, logged = [], None, None
    for row in readings:
        key = row["blocks"]
        if key and key == previous and key != logged:
            at = row["t"] + SCAN_MS / 1000
            outcome = merge(key, entries, at)
            if outcome != "skip":
                entries.append({"at": at, "blocks": key, "replaces": outcome})
            logged = key
        previous = key
    return entries


# --- what was said ------------------------------------------------------------------------------


def transcriber():
    try:
        import mlx_whisper

        return lambda audio: mlx_whisper.transcribe(
            audio, path_or_hf_repo="mlx-community/whisper-large-v3-mlx", language="ja",
            word_timestamps=True, condition_on_previous_text=False)
    except ImportError:
        import whisper

        model = whisper.load_model("large-v3")
        return lambda audio: model.transcribe(audio, language="ja", word_timestamps=True, condition_on_previous_text=False)


def heard(audio16, spans, cache):
    """Whisper's words (text, start s, end s) for each span (from s, to s), transcribed alone."""
    path = cache / "heard.json"
    done = json.loads(path.read_text()) if path.exists() else {}
    transcribe = None
    for start, end in spans:
        key = f"{start:.2f}-{end:.2f}"
        if key in done:
            continue
        transcribe = transcribe or transcriber()
        piece = audio16[int(start * WHISPER_RATE):int(end * WHISPER_RATE)]
        result = transcribe(piece)
        done[key] = [
            (w["word"], start + w["start"], start + w["end"])
            for seg in result["segments"] for w in seg.get("words", [])
            if seg.get("no_speech_prob", 0) < 0.8
        ]
        path.write_text(json.dumps(done, ensure_ascii=False))
    return {k: [tuple(w) for w in v] for k, v in done.items()}


def align(line, words):
    """Smith-Waterman of the line's letters against the heard words' letters: (matched letters,
    time of the first matched word, time of the last)."""
    a = letters(line)
    chars = [(c, i) for i, (w, _, _) in enumerate(words) for c in letters(w)]
    if not a or not chars:
        return 0, None, None
    n, m = len(a), len(chars)
    score = np.zeros((n + 1, m + 1), np.int32)
    best, at = 0, (0, 0)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            s = max(0, score[i - 1, j - 1] + (2 if a[i - 1] == chars[j - 1][0] else -1),
                    score[i - 1, j] - 1, score[i, j - 1] - 1)
            score[i, j] = s
            if s > best:
                best, at = s, (i, j)
    i, j = at
    matched, first, last = 0, None, None
    while i > 0 and j > 0 and score[i, j] > 0:
        if a[i - 1] == chars[j - 1][0] and score[i, j] == score[i - 1, j - 1] + 2:
            matched += 1
            last = chars[j - 1][1] if last is None else last
            first = chars[j - 1][1]
            i, j = i - 1, j - 1
        elif score[i, j] == score[i - 1, j] - 1:
            i -= 1
        elif score[i, j] == score[i, j - 1] - 1:
            j -= 1
        else:
            first = chars[j - 1][1]
            i, j = i - 1, j - 1
    if not matched:
        return 0, None, None
    return matched, words[first][1], words[last][2]


# --- the sessions -------------------------------------------------------------------------------


def shown_spans(readings):
    """For each block text: when it was first and last on screen (s)."""
    spans = {}
    step = readings[1]["t"] - readings[0]["t"] if len(readings) > 1 else 0.2
    for row in readings:
        for text in row["blocks"]:
            first, _ = spans.get(text, (row["t"], 0))
            spans[text] = (first, row["t"] + step)
    return spans


def truths(texts, shown, words_of, corrections):
    """Each block text's voice: (voiced, start s, end s, how it was decided)."""
    out = {}
    for text in texts:
        first, last = shown[text]
        words = words_of(first, last)
        size = len(letters(text))
        matched, start, end = align(text, words)
        voiced = size >= 2 and matched >= max(2, 0.5 * size)
        why = f"{matched}/{size} heard"
        fix = corrections.get(text)
        if fix:
            voiced = fix.get("voiced", True)
            start, end = fix.get("startS", start), fix.get("endS", end)
            why += ", corrected"
        out[text] = (voiced, start if voiced else None, end if voiced else None, why)
    # A misreading of a voiced text, on screen at the same time, is that line too (its own words
    # may have been transcribed over too short a time to be heard).
    for text in texts:
        if out[text][0] or text in corrections:
            continue
        a = letters(text)
        for other in texts:
            b = letters(other)
            overlaps = shown[other][0] < shown[text][1] and shown[text][0] < shown[other][1]
            if out[other][0] and overlaps and len(a) >= 4 and \
                    difflib.SequenceMatcher(None, a, b).ratio() >= 0.8:
                out[text] = out[other][:3] + (f"as “{other[:12]}”",)
                break
    return out


def row(uid, text, ts, scan, truth, replaces=()):
    voiced, start, end, _ = truth
    line = {"uid": uid, "text": text, "ts": T0 + ts * 1000, "source": "ocr", "scan": scan}
    if replaces:
        line["replaces"] = list(replaces)
    line["truth"] = {"voiced": voiced}
    if voiced:
        line["truth"].update(startMs=T0 + start * 1000, endMs=T0 + end * 1000)
    return line


def write_session(dir, lines, screen, note):
    dir.mkdir(parents=True, exist_ok=True)
    (dir / "session.json").write_text(json.dumps({"audio": "../audio.wav", "audioStartMs": T0, "notes": note}, indent=2))
    (dir / "lines.jsonl").write_text("".join(json.dumps(l, ensure_ascii=False) + "\n" for l in lines))
    (dir / "screen.jsonl").write_text("".join(json.dumps(s, ensure_ascii=False) + "\n" for s in screen))


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("video", type=Path)
    parser.add_argument("out", type=Path)
    parser.add_argument("--crop", help="x,y,w,h of the text region (default: the whole frame)")
    parser.add_argument("--fps", type=float, default=5.0)
    parser.add_argument("--seed", type=int, default=3)
    args = parser.parse_args()
    out, cache = args.out, args.out / "cache"
    cache.mkdir(parents=True, exist_ok=True)

    if args.crop:
        crop = tuple(int(v) for v in args.crop.split(","))
    else:
        size = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                               "stream=width,height", "-of", "csv=p=0", str(args.video)],
                              capture_output=True, text=True, check=True).stdout.strip().split(",")
        crop = (0, 0, int(size[0]), int(size[1]))
    if not (out / "audio.wav").exists():
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(args.video), "-ac", "1", "-ar", str(RATE),
                        str(out / "audio.wav")], check=True)
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(args.video), "-ac", "1", "-ar", str(WHISPER_RATE),
                          "-f", "f32le", "-"], capture_output=True, check=True).stdout
    audio16 = np.frombuffer(pcm, np.float32)

    readings = read_screen(args.video, crop, args.fps, cache)
    shown = shown_spans(readings)
    texts = sorted(shown, key=lambda t: shown[t][0])
    # Each text's time on screen, a little either side, transcribed on its own.
    spans = sorted({(round(max(0, shown[t][0] - 0.5), 2), round(shown[t][1] + 1.0, 2)) for t in texts if len(letters(t)) >= 2})
    words = heard(audio16, spans, cache)
    corrections = json.loads((out / "truth.json").read_text()) if (out / "truth.json").exists() else {}
    truth = truths(texts, shown, lambda a, b: words.get(f"{max(0, a - 0.5):.2f}-{b + 1.0:.2f}", []), corrections)

    screen = []
    for r in readings:
        text = "\n".join(r["blocks"])
        if not screen or screen[-1]["text"] != text:
            screen.append({"at": T0 + r["t"] * 1000, "text": text})

    # Automatic OCR.
    lines, uids_of = [], []
    for k, entry in enumerate(auto_scans(readings)):
        scan = f"a{k + 1:03}"
        uids = [f"{scan}.{i + 1}" for i in range(len(entry["blocks"]))]
        replaced = [u for e in entry["replaces"] for u in uids_of[e["index"]]] if entry["replaces"] else []
        entry["index"] = k
        uids_of.append(uids)
        for i, text in enumerate(entry["blocks"]):
            lines.append(row(uids[i], text, entry["at"], scan, truth[text], replaced if i == 0 else ()))
    write_session(out / "auto", lines, screen, f"automatic OCR of {args.video.name}")

    # Manual OCR: each new voiced or unvoiced dialogue scanned once while it is up, a third of
    # the voiced ones while the voice still plays, the rest after it.
    chance = random.Random(args.seed)
    lines, scanned = [], set()
    for r_index, r in enumerate(readings):
        new = [t for t in r["blocks"] if t not in scanned and len(letters(t)) >= 2]
        if not new:
            continue
        up_to = next((x["t"] for x in readings[r_index:] if x["blocks"] != r["blocks"]), r["t"] + 1)
        voiced = [truth[t] for t in new if truth[t][0]]
        if voiced and chance.random() < 1 / 3:
            _, start, end, _ = voiced[0]
            at = max(r["t"] + 0.2, start + (end - start) * chance.uniform(0.2, 0.8))
        elif voiced:
            at = max(r["t"] + 0.2, max(v[2] for v in voiced) + chance.uniform(0.3, 3.0))
        else:
            at = r["t"] + chance.uniform(0.3, 3.0)
        if at >= up_to:
            continue  # gone before the player would have scanned it
        scanned.update(r["blocks"])
        scan = f"m{len({l['scan'] for l in lines}) + 1:03}"
        for i, text in enumerate(r["blocks"]):
            lines.append(row(f"{scan}.{i + 1}", text, at, scan, truth[text]))
    write_session(out / "manual", lines, [], f"manual OCR of {args.video.name}")

    with open(out / "truth.txt", "w") as f:
        for text in texts:
            voiced, start, end, why = truth[text]
            first, last = shown[text]
            voice = f"{start:7.2f}-{end:7.2f}" if voiced else "   unvoiced    "
            f.write(f"{first:7.2f}-{last:7.2f}  {voice}  {why:14}  {text.replace(chr(10), ' / ')}\n")
    print(f"{len(texts)} texts, {sum(t[0] for t in truth.values())} voiced; sessions in {out}/auto and {out}/manual")


if __name__ == "__main__":
    main()

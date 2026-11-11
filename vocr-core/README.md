# kimochi-vocr

VOCR6 from [bee-san/vita-vn-ocr](https://github.com/bee-san/vita-vn-ocr) on ONNX Runtime: the
textspot8 dialogue-line spotter, the VOCR6.2 recognizer, the 1 MB character LM and the character
cells used for hover lookups. It is a Rust port of the release's reference pipeline
`vocr_onnx.py` ([v0.5.1-onnx.2](https://github.com/bee-san/vita-vn-ocr/releases/tag/v0.5.1-onnx.2),
[docs/onnx.md](https://github.com/bee-san/vita-vn-ocr/blob/main/docs/onnx.md)). It follows the
reference integer for integer outside the networks, so given the same models it gives the same
lines, texts and cells.

Kimochi uses it through `src-tauri/src/vocr.rs`. It runs the Large recognizer in its "fast" form,
with the LM, on the CPU, and downloads the three files listed in `src-tauri/ocr-models.json`.
`Vocr::read_frame` is the reference's `read_region`. `Vocr::read_capture` adds what an app needs
on top: it scales the capture down to fit 1280 × 720, maps boxes back to capture pixels, and drops
lines with no kana or kanji, as Rubi does (`Config::japanese_only`; Kimochi turns it off and
leaves this to its own "Drop lines" setting).

## Checking it against the reference

`cargo test` covers the pieces. For an end-to-end check, use the release's files and its Python
reference (`pip install onnxruntime==1.30.0 numpy pillow`):

```sh
gh release download v0.5.1-onnx.2 -R bee-san/vita-vn-ocr -D /tmp/vocr
ORT_DYLIB_PATH=…/libonnxruntime.dylib cargo run --release --example vocr -- \
    --models /tmp/vocr --tier L --mode exact --lm IMAGE.png...
python3 /tmp/vocr/vocr_onnx.py --models /tmp/vocr --tier L --mode exact \
    --lm /tmp/vocr/vocr_lm6_o3_1000k.vlm IMAGE.png...
```

Both commands print one JSON line per image. The texts, boxes, tags, dark flags and character cells
should be identical. Use PNG files: JPEG decoders differ slightly between the two. `--repeat N`
also times the reads.

Licence: GPL-3.0-only, as a port of GPL-3.0-or-later code. The models are not part of this crate.
They are GPL-3.0-or-later, for non-commercial use only, and the LM is CC BY-SA 4.0 (the release's
attribution files).

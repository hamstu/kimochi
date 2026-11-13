//! The VOCR6 line recognizer (`vocr_onnx.Recognizer`): preprocessing, the network, greedy CTC, the
//! confidence, the character cells and, with an LM, the beam + LM text.
use crate::chars::{self, Char, Q};
use crate::grey::{preprocess, Grey};
use crate::lm::CharLm;
use crate::onnx::{self, Meta};
use crate::Error;
use ort::session::run_options::{HasSelectedOutputs, OutputSelector, RunOptions};
use ort::session::Session;
use ort::value::{Tensor, TensorRef};
use std::path::Path;

/// One line read: its text and characters in the crop's pixels until the pipeline places it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Line {
    /// The greedy text, or the beam + LM text when an LM read it.
    pub text: String,
    pub greedy: String,
    /// x, y, w, h.
    pub bbox: (i64, i64, i64, i64),
    /// The greedy characters with their cells.
    pub chars: Vec<Char>,
    /// The characters of `text` with their cells (LM insertions share a neighbour's).
    pub text_chars: Vec<Char>,
    pub conf_min: f32,
    pub conf_mean: f32,
    pub frames: usize,
    /// The resized width before padding.
    pub width: usize,
    pub dark: bool,
    pub tag: usize,
    pub conf: i64,
    pub block: usize,
}

pub struct Recognizer {
    session: Session,
    run: RunOptions<HasSelectedOutputs>,
    pub vocab: Vec<String>,
    pub height: usize,
    pub stride: usize,
    pub max_width: usize,
    pub mode: String,
    pub name: String,
    cal: [i64; 9],
    groups: Vec<u8>,
    has_sections: bool,
    topk: usize,
}

impl Recognizer {
    pub fn load(path: &Path, threads: usize) -> Result<Self, Error> {
        let session = onnx::session(path, threads)?;
        let meta = Meta::read(&session)?;
        if meta.str("vocr.kind")? != "recognizer" {
            return Err(Error::Model(format!("{}: not a recognizer", path.display())));
        }
        let vocab: Vec<String> = meta.get("vocr.vocab")?;
        let cal = match meta.value("vocr.charbox_cal") {
            Ok(v) if !v.is_null() => meta.get::<[i64; 9]>("vocr.charbox_cal")?,
            _ => [0; 9],
        };
        let groups = vocab.iter().map(|t| chars::char_group(t) as u8).collect();
        let has_sections = session.inputs.iter().any(|i| i.name == "head_sections");
        // Only what the pipeline reads: not the full `logits` (frames x 5,631 floats per line).
        let run = RunOptions::new()?.with_outputs(
            OutputSelector::no_default().with("best").with("topk_logits").with("topk_classes").with("blank_logit"),
        );
        Ok(Self {
            vocab,
            height: meta.int("vocr.height")? as usize,
            stride: meta.int("vocr.stride")? as usize,
            max_width: meta.int("vocr.max_width")? as usize,
            mode: meta.str("vocr.mode")?.to_string(),
            name: meta.value("vocr.name").ok().and_then(|v| v.as_str()).unwrap_or("").to_string(),
            topk: meta.int("vocr.topk")? as usize,
            cal,
            groups,
            has_sections,
            session,
            run,
        })
    }

    /// One line crop -> Line, in the crop's px. `invert`: dark text (the spotter's dark flag).
    /// `sections`: the head gate / two-level head as Rubi runs them.
    pub fn read(&mut self, g: &Grey, invert: bool, sections: bool, lm: Option<&mut CharLm>) -> Result<Line, Error> {
        let (x, nw) = preprocess(g, invert, self.height, self.stride, self.max_width);
        let padded = x.len() / self.height;
        let grey = TensorRef::from_array_view(([1usize, 1, self.height, padded], x.as_slice()))?;
        let outputs = if self.has_sections {
            let flag = Tensor::from_array((Vec::<i64>::new(), vec![sections]))?;
            self.session.run_with_options(ort::inputs!["grey" => grey, "head_sections" => flag], &self.run)?
        } else {
            self.session.run_with_options(ort::inputs!["grey" => grey], &self.run)?
        };
        let (_, best) = outputs["best"].try_extract_tensor::<i64>()?;
        let (tshape, topv) = outputs["topk_logits"].try_extract_tensor::<f32>()?;
        let (_, topc) = outputs["topk_classes"].try_extract_tensor::<i64>()?;
        let (_, blank) = outputs["blank_logit"].try_extract_tensor::<f32>()?;
        let k = if tshape.len() == 2 { tshape[1] as usize } else { self.topk };
        let sp = chars::spans(best);
        let greedy: String = sp.iter().map(|&(c, _, _)| self.vocab[c as usize].as_str()).collect();
        let (mut cmin, mut cmean) = (1.0f32, 1.0f32);
        let p: Vec<f32> =
            sp.iter().map(|&(_, f0, _)| chars::topk_conf(&topv[f0 as usize * k..(f0 as usize + 1) * k])).collect();
        if !sp.is_empty() {
            cmin = p.iter().copied().fold(f32::INFINITY, f32::min);
            let mut s = 0f32;
            for v in &p {
                s += v;
            }
            cmean = s / p.len() as f32;
        }
        let (h, w) = (g.height as i64, g.width as i64);
        let cells = chars::cells(&sp, w, h, nw as i64, &self.cal, &self.groups, self.stride as i64);
        let chars: Vec<Char> = sp
            .iter()
            .zip(cells)
            .zip(&p)
            .map(|((&(cls, f0, f1), (c, x0, x1)), &conf)| Char {
                text: self.vocab[cls as usize].clone(),
                cls,
                f0,
                f1,
                x: c as f32 / Q as f32,
                x0: x0 as f32 / Q as f32,
                x1: x1 as f32 / Q as f32,
                y0: 0,
                y1: h,
                conf,
            })
            .collect();
        let text = match lm {
            Some(lm) if !greedy.is_empty() => {
                let classes = lm.decode_classes(&self.vocab, topv, topc, k, Some(blank))?;
                classes.iter().map(|&c| self.vocab[c as usize].as_str()).collect()
            }
            _ => greedy.clone(),
        };
        let text_chars = chars::place(&text, &chars);
        Ok(Line {
            text,
            greedy,
            bbox: (0, 0, w, h),
            chars,
            text_chars,
            conf_min: cmin,
            conf_mean: cmean,
            frames: best.len(),
            width: nw,
            dark: invert,
            tag: 0,
            conf: 0,
            block: 0,
        })
    }
}

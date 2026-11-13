//! VOCR6 (bee-san/vita-vn-ocr) on ONNX Runtime: a Rust port of the release's reference pipeline
//! `vocr_onnx.py` (v0.5.1-onnx.2), integer for integer outside the networks, so with the "exact" files
//! the lines, texts and character cells equal the Python reference's (and upstream's C runtime's).
//!
//! The pipeline (`Vocr::read_frame`): the textspot8 spotter finds the horizontal lines (with their dark
//! flag and class: dialogue, name, choice, UI, scene), the recognizer reads each, the optional
//! character LM re-decodes it with a beam, and each character gets its cell along the line.
//!
//! `Vocr::read_capture` adds what an app needs around it and is not in the reference: the capture is
//! scaled down to a frame size VOCR reads well (`fit`), and the boxes come back in the capture's pixels.
//!
//! The code is a port of GPL-3.0-or-later code (bee-san/vita-vn-ocr's `tools/vocr_onnx.py`), used here
//! under GPL-3.0. The model files it reads are not part of this crate.

pub mod chars;
pub mod grey;
pub mod lm;
mod onnx;
pub mod recognizer;
pub mod spotter;

pub use chars::Char;
pub use grey::Grey;
pub use lm::{CharLm, LmSettings};
pub use recognizer::{Line, Recognizer};
pub use spotter::{Spots, Spotter};

use std::path::{Path, PathBuf};

/// The `vocr.format` the files carry.
pub const FORMAT: i64 = 1;

#[derive(Debug)]
pub enum Error {
    /// A model file is missing, unreadable or not what it should be.
    Model(String),
    /// The input cannot be read (an empty or oversized image).
    Input(String),
    /// ONNX Runtime failed.
    Runtime(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Model(m) => write!(f, "model: {m}"),
            Error::Input(m) => write!(f, "input: {m}"),
            Error::Runtime(m) => write!(f, "ONNX Runtime: {m}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<ort::Error> for Error {
    fn from(e: ort::Error) -> Self {
        Error::Runtime(e.to_string())
    }
}

/// The files: the spotter, a recognizer and, optionally, the character LM.
#[derive(Debug, Clone)]
pub struct ModelPaths {
    pub spotter: PathBuf,
    pub recognizer: PathBuf,
    pub lm: Option<PathBuf>,
}

impl ModelPaths {
    /// Upstream's file names in one directory: `textspot8_exact.onnx`, `VOCR6.2_<tier>_<mode>.onnx`
    /// and, when `lm`, `vocr_lm6_o3_1000k.vlm`.
    pub fn from_dir(dir: impl AsRef<Path>, tier: &str, mode: &str, lm: bool) -> Self {
        let dir = dir.as_ref();
        Self {
            spotter: dir.join("textspot8_exact.onnx"),
            recognizer: dir.join(format!("VOCR6.2_{tier}_{mode}.onnx")),
            lm: lm.then(|| dir.join("vocr_lm6_o3_1000k.vlm")),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Config {
    /// Intra-op threads per session. One is fastest for these tiny graphs (upstream measured
    /// 5 threads slower for every exact file and level for Large fast).
    pub threads: usize,
    /// The head gate / two-level head as Rubi runs them (speed only).
    pub sections: bool,
    /// The capture is scaled down to fit this frame (either orientation) before the spotter.
    pub fit: (usize, usize),
    /// Intra-op threads for the spotter, whose one run per frame gains from a second thread
    /// (the recognizer's short per-line runs do not).
    pub spotter_threads: usize,
    /// `read_capture` drops lines with no kana or kanji (copyright notices, Latin UI), as Rubi does.
    pub japanese_only: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self { threads: 1, sections: true, fit: (1280, 720), spotter_threads: 2, japanese_only: true }
    }
}

pub struct Vocr {
    pub spotter: Spotter,
    pub recognizer: Recognizer,
    pub lm: Option<CharLm>,
    pub config: Config,
}

impl Vocr {
    pub fn load(paths: &ModelPaths, config: Config) -> Result<Self, Error> {
        let spotter = Spotter::load(&paths.spotter, config.spotter_threads)?;
        let recognizer = Recognizer::load(&paths.recognizer, config.threads)?;
        let lm = match &paths.lm {
            Some(p) => {
                let bytes = std::fs::read(p).map_err(|e| Error::Model(format!("{}: {e}", p.display())))?;
                Some(CharLm::from_bytes(&bytes, LmSettings::RUBI_LM6)?)
            }
            None => None,
        };
        Ok(Self { spotter, recognizer, lm, config })
    }

    /// `read_region`: the spotter on the region (the whole frame for `None`) at the frame's scale, then
    /// every horizontal box (or those of `tags`), cut from the region's grey and read with its dark flag.
    /// Boxes and cells in frame px, in reading order.
    pub fn read_frame(
        &mut self,
        frame: &Grey,
        region: Option<(i64, i64, i64, i64)>,
        tags: Option<&[usize]>,
    ) -> Result<Vec<Line>, Error> {
        let (w, h) = (frame.width as i64, frame.height as i64);
        let (rx, ry, rw, rh) = region.unwrap_or((0, 0, w, h));
        let (x0, y0) = (rx.clamp(0, w), ry.clamp(0, h));
        let (x1, y1) = ((rx + rw).clamp(0, w), (ry + rh).clamp(0, h));
        if x1 <= x0 || y1 <= y0 {
            return Ok(Vec::new());
        }
        let sub_owned;
        let sub = if (x0, y0, x1, y1) == (0, 0, w, h) {
            frame
        } else {
            sub_owned = frame.crop(x0 as usize, y0 as usize, (x1 - x0) as usize, (y1 - y0) as usize);
            &sub_owned
        };
        let spots = self.spotter.spot(sub, Some((frame.width, frame.height)))?;
        let mut out = Vec::new();
        for b in &spots.boxes {
            if b.vertical || tags.is_some_and(|t| !t.contains(&b.tag)) {
                continue;
            }
            let crop = sub.crop(b.x as usize, b.y as usize, b.w as usize, b.h as usize);
            let mut line = self.recognizer.read(&crop, b.dark, self.config.sections, self.lm.as_mut())?;
            line.bbox = (x0 + b.x, y0 + b.y, b.w, b.h);
            line.tag = b.tag;
            line.conf = b.conf;
            line.block = b.block;
            let (dx, dy) = ((x0 + b.x) as f32, y0 + b.y);
            for c in line.chars.iter_mut().chain(line.text_chars.iter_mut()) {
                c.x += dx;
                c.x0 += dx;
                c.x1 += dx;
                c.y0 = dy;
                c.y1 = dy + b.h;
            }
            out.push(line);
        }
        Ok(out)
    }

    /// The scale a capture of this size is read at: down to fit `config.fit` (in its own orientation),
    /// never up.
    pub fn scale_for(&self, width: usize, height: usize) -> f64 {
        let (a, b) = self.config.fit;
        let (fw, fh) = if width >= height { (a.max(b), a.min(b)) } else { (a.min(b), a.max(b)) };
        (fw as f64 / width as f64).min(fh as f64 / height as f64).min(1.0)
    }

    /// A capture of any size: scaled to fit (`scale_for`), read whole, and the boxes and cells mapped
    /// back to the capture's pixels.
    pub fn read_capture(&mut self, capture: &Grey) -> Result<Vec<Line>, Error> {
        let mut lines = self.read_scaled(capture)?;
        if self.config.japanese_only {
            lines.retain(|l| has_japanese(&l.text));
        }
        Ok(lines)
    }

    fn read_scaled(&mut self, capture: &Grey) -> Result<Vec<Line>, Error> {
        if capture.width == 0 || capture.height == 0 {
            return Ok(Vec::new());
        }
        let s = self.scale_for(capture.width, capture.height);
        if s >= 1.0 {
            return self.read_frame(capture, None, None);
        }
        let (w, h) = (
            ((capture.width as f64 * s).round() as usize).max(1),
            ((capture.height as f64 * s).round() as usize).max(1),
        );
        let frame = capture.resize_area(w, h);
        let (sx, sy) = (capture.width as f64 / w as f64, capture.height as f64 / h as f64);
        let mut lines = self.read_frame(&frame, None, None)?;
        let (cw, ch) = (capture.width as i64, capture.height as i64);
        let fx = |v: f64| (v * sx).round() as i64;
        let fy = |v: f64| (v * sy).round() as i64;
        for line in &mut lines {
            let (x, y, bw, bh) = line.bbox;
            let (x0, y0) = (fx(x as f64).clamp(0, cw), fy(y as f64).clamp(0, ch));
            let (x1, y1) = (fx((x + bw) as f64).clamp(0, cw), fy((y + bh) as f64).clamp(0, ch));
            line.bbox = (x0, y0, x1 - x0, y1 - y0);
            for c in line.chars.iter_mut().chain(line.text_chars.iter_mut()) {
                c.x = (c.x as f64 * sx) as f32;
                c.x0 = (c.x0 as f64 * sx) as f32;
                c.x1 = (c.x1 as f64 * sx) as f32;
                c.y0 = y0;
                c.y1 = y1;
            }
        }
        Ok(lines)
    }
}

/// Whether a text holds kana or kanji (the filter Rubi applies to its lines, `eval/pagepath.py`).
pub fn has_japanese(text: &str) -> bool {
    text.chars().any(|c| {
        matches!(c as u32, 0x3041..=0x309F | 0x30A0..=0x30FF | 0x31F0..=0x31FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF66..=0xFF9D)
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn japanese_lines_are_kept() {
        assert!(super::has_japanese("「ねえ」"));
        assert!(super::has_japanese("HPが"));
        assert!(super::has_japanese("ｱｲ"));
        assert!(!super::has_japanese("(C)2016 IDEA FACTORY"));
        assert!(!super::has_japanese("１２３！？"));
    }
}

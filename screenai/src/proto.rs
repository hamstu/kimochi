//! The library's answer: a serialized `chrome_screen_ai.VisualAnnotation`, decoded by hand.
//!
//! Only the fields Kimochi reads are kept. Field numbers are from Chromium's
//! `services/screen_ai/proto/chrome_screen_ai.proto`; unknown fields are skipped, so a newer
//! library that adds some still decodes.
//!
//! ```text
//! VisualAnnotation { repeated LineBox lines = 2; }
//! LineBox  { repeated WordBox words = 1; Rect bounding_box = 2; string utf8_string = 3;
//!            string language = 4; int32 block_id = 5; Direction direction = 7;
//!            ContentType content_type = 8; float confidence = 10; int32 paragraph_id = 11; }
//! WordBox  { repeated SymbolBox symbols = 1; Rect bounding_box = 2; string utf8_string = 3;
//!            string language = 5; bool has_space_after = 6; Direction direction = 12;
//!            float confidence = 15; }
//! SymbolBox { Rect bounding_box = 1; string utf8_string = 2; float confidence = 3; }
//! Rect     { int32 x = 1; int32 y = 2; int32 width = 3; int32 height = 4; float angle = 5; }
//! ```

/// A box in the pixels of the image the library read. `angle` is in degrees, clockwise, about
/// the top-left corner (`x`, `y`).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    pub angle: f32,
}

impl Rect {
    /// The four corners, rotated by `angle` about the top-left corner: top-left, top-right,
    /// bottom-right, bottom-left of the unrotated box.
    pub fn corners(&self) -> [[f64; 2]; 4] {
        let (x, y) = (f64::from(self.x), f64::from(self.y));
        let (w, h) = (f64::from(self.width), f64::from(self.height));
        let (sin, cos) = f64::from(self.angle).to_radians().sin_cos();
        let at = |dx: f64, dy: f64| [x + dx * cos - dy * sin, y + dx * sin + dy * cos];
        [at(0., 0.), at(w, 0.), at(w, h), at(0., h)]
    }

    /// The axis-aligned box around the (rotated) rectangle: `[x1, y1, x2, y2]`.
    pub fn bounds(&self) -> [f64; 4] {
        let corners = self.corners();
        let xs = corners.map(|c| c[0]);
        let ys = corners.map(|c| c[1]);
        let min = |v: [f64; 4]| v.into_iter().fold(f64::INFINITY, f64::min);
        let max = |v: [f64; 4]| v.into_iter().fold(f64::NEG_INFINITY, f64::max);
        [min(xs), min(ys), max(xs), max(ys)]
    }
}

/// `chrome_screen_ai.Direction`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Direction {
    #[default]
    Unspecified,
    LeftToRight,
    RightToLeft,
    TopToBottom,
}

impl Direction {
    fn from_wire(value: u64) -> Self {
        match value {
            1 => Direction::LeftToRight,
            2 => Direction::RightToLeft,
            3 => Direction::TopToBottom,
            _ => Direction::Unspecified,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Symbol {
    pub text: String,
    pub bounding_box: Rect,
    pub confidence: f32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Word {
    pub text: String,
    pub bounding_box: Rect,
    pub symbols: Vec<Symbol>,
    pub has_space_after: bool,
    pub direction: Direction,
    pub confidence: f32,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Line {
    pub text: String,
    pub bounding_box: Rect,
    pub words: Vec<Word>,
    pub language: String,
    pub block_id: i32,
    pub paragraph_id: i32,
    pub direction: Direction,
    /// `ContentType`: 0 printed text, 1 handwritten; the rest (images, separators…) are not text.
    pub content_type: u32,
    pub confidence: f32,
}

/// Decode a `VisualAnnotation` into its lines, in the library's reading order.
pub fn decode(bytes: &[u8]) -> Result<Vec<Line>, String> {
    let mut lines = Vec::new();
    for field in Fields::new(bytes) {
        let (number, value) = field?;
        if let (2, Value::Bytes(b)) = (number, value) {
            lines.push(line(b)?);
        }
    }
    Ok(lines)
}

fn line(bytes: &[u8]) -> Result<Line, String> {
    let mut line = Line::default();
    for field in Fields::new(bytes) {
        match field? {
            (1, Value::Bytes(b)) => line.words.push(word(b)?),
            (2, Value::Bytes(b)) => line.bounding_box = rect(b)?,
            (3, Value::Bytes(b)) => line.text = string(b),
            (4, Value::Bytes(b)) => line.language = string(b),
            (5, Value::Varint(v)) => line.block_id = v as i32,
            (7, Value::Varint(v)) => line.direction = Direction::from_wire(v),
            (8, Value::Varint(v)) => line.content_type = v as u32,
            (10, Value::Fixed32(v)) => line.confidence = f32::from_bits(v),
            (11, Value::Varint(v)) => line.paragraph_id = v as i32,
            _ => {}
        }
    }
    Ok(line)
}

fn word(bytes: &[u8]) -> Result<Word, String> {
    let mut word = Word::default();
    for field in Fields::new(bytes) {
        match field? {
            (1, Value::Bytes(b)) => word.symbols.push(symbol(b)?),
            (2, Value::Bytes(b)) => word.bounding_box = rect(b)?,
            (3, Value::Bytes(b)) => word.text = string(b),
            (6, Value::Varint(v)) => word.has_space_after = v != 0,
            (12, Value::Varint(v)) => word.direction = Direction::from_wire(v),
            (15, Value::Fixed32(v)) => word.confidence = f32::from_bits(v),
            _ => {}
        }
    }
    Ok(word)
}

fn symbol(bytes: &[u8]) -> Result<Symbol, String> {
    let mut symbol = Symbol::default();
    for field in Fields::new(bytes) {
        match field? {
            (1, Value::Bytes(b)) => symbol.bounding_box = rect(b)?,
            (2, Value::Bytes(b)) => symbol.text = string(b),
            (3, Value::Fixed32(v)) => symbol.confidence = f32::from_bits(v),
            _ => {}
        }
    }
    Ok(symbol)
}

fn rect(bytes: &[u8]) -> Result<Rect, String> {
    let mut rect = Rect::default();
    for field in Fields::new(bytes) {
        match field? {
            // int32 on the wire is the 64-bit two's complement varint; truncating keeps the sign.
            (1, Value::Varint(v)) => rect.x = v as i32,
            (2, Value::Varint(v)) => rect.y = v as i32,
            (3, Value::Varint(v)) => rect.width = v as i32,
            (4, Value::Varint(v)) => rect.height = v as i32,
            (5, Value::Fixed32(v)) => rect.angle = f32::from_bits(v),
            _ => {}
        }
    }
    Ok(rect)
}

fn string(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Value<'a> {
    Varint(u64),
    Fixed64(u64),
    Bytes(&'a [u8]),
    Fixed32(u32),
}

/// The fields of one message, in order.
struct Fields<'a> {
    bytes: &'a [u8],
    at: usize,
    failed: bool,
}

impl<'a> Fields<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, at: 0, failed: false }
    }

    fn varint(&mut self) -> Result<u64, String> {
        let mut value = 0u64;
        for shift in (0..64).step_by(7) {
            let byte = *self.bytes.get(self.at).ok_or("truncated varint")?;
            self.at += 1;
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err("varint longer than 10 bytes".into())
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], String> {
        let end = self.at.checked_add(n).ok_or("length overflows")?;
        let slice = self.bytes.get(self.at..end).ok_or("truncated field")?;
        self.at = end;
        Ok(slice)
    }

    fn next_field(&mut self) -> Result<(u32, Value<'a>), String> {
        let key = self.varint()?;
        let number = u32::try_from(key >> 3).map_err(|_| "field number out of range")?;
        let value = match key & 7 {
            0 => Value::Varint(self.varint()?),
            1 => Value::Fixed64(u64::from_le_bytes(self.take(8)?.try_into().unwrap())),
            2 => {
                let len = usize::try_from(self.varint()?).map_err(|_| "length out of range")?;
                Value::Bytes(self.take(len)?)
            }
            5 => Value::Fixed32(u32::from_le_bytes(self.take(4)?.try_into().unwrap())),
            wire => return Err(format!("unsupported wire type {wire}")),
        };
        Ok((number, value))
    }
}

impl<'a> Iterator for Fields<'a> {
    type Item = Result<(u32, Value<'a>), String>;
    fn next(&mut self) -> Option<Self::Item> {
        if self.failed || self.at >= self.bytes.len() {
            return None;
        }
        let field = self.next_field();
        self.failed = field.is_err();
        Some(field.map_err(|e| format!("Screen AI result: {e}")))
    }
}

/// Encoding, for tests (here and in Kimochi) that need a library answer without the library.
pub mod encode {
    use super::{Direction, Line, Rect, Symbol, Word};

    fn varint(out: &mut Vec<u8>, mut v: u64) {
        while v >= 0x80 {
            out.push((v as u8) | 0x80);
            v >>= 7;
        }
        out.push(v as u8);
    }
    fn key(out: &mut Vec<u8>, number: u32, wire: u8) {
        varint(out, u64::from(number) << 3 | u64::from(wire));
    }
    fn int(out: &mut Vec<u8>, number: u32, v: i64) {
        if v != 0 {
            key(out, number, 0);
            varint(out, v as u64);
        }
    }
    fn float(out: &mut Vec<u8>, number: u32, v: f32) {
        if v != 0. {
            key(out, number, 5);
            out.extend_from_slice(&v.to_bits().to_le_bytes());
        }
    }
    fn bytes(out: &mut Vec<u8>, number: u32, b: &[u8]) {
        key(out, number, 2);
        varint(out, b.len() as u64);
        out.extend_from_slice(b);
    }
    fn direction(d: Direction) -> i64 {
        match d {
            Direction::Unspecified => 0,
            Direction::LeftToRight => 1,
            Direction::RightToLeft => 2,
            Direction::TopToBottom => 3,
        }
    }
    fn rect(r: &Rect) -> Vec<u8> {
        let mut out = Vec::new();
        int(&mut out, 1, r.x.into());
        int(&mut out, 2, r.y.into());
        int(&mut out, 3, r.width.into());
        int(&mut out, 4, r.height.into());
        float(&mut out, 5, r.angle);
        out
    }
    fn symbol(s: &Symbol) -> Vec<u8> {
        let mut out = Vec::new();
        bytes(&mut out, 1, &rect(&s.bounding_box));
        bytes(&mut out, 2, s.text.as_bytes());
        float(&mut out, 3, s.confidence);
        out
    }
    fn word(w: &Word) -> Vec<u8> {
        let mut out = Vec::new();
        for s in &w.symbols {
            bytes(&mut out, 1, &symbol(s));
        }
        bytes(&mut out, 2, &rect(&w.bounding_box));
        bytes(&mut out, 3, w.text.as_bytes());
        int(&mut out, 6, i64::from(w.has_space_after));
        int(&mut out, 12, direction(w.direction));
        float(&mut out, 15, w.confidence);
        out
    }
    fn line(l: &Line) -> Vec<u8> {
        let mut out = Vec::new();
        for w in &l.words {
            bytes(&mut out, 1, &word(w));
        }
        bytes(&mut out, 2, &rect(&l.bounding_box));
        bytes(&mut out, 3, l.text.as_bytes());
        bytes(&mut out, 4, l.language.as_bytes());
        int(&mut out, 5, l.block_id.into());
        int(&mut out, 7, direction(l.direction));
        int(&mut out, 8, l.content_type.into());
        float(&mut out, 10, l.confidence);
        int(&mut out, 11, l.paragraph_id.into());
        out
    }
    /// A serialized `VisualAnnotation` holding `lines`.
    pub fn annotation(lines: &[Line]) -> Vec<u8> {
        let mut out = Vec::new();
        for l in lines {
            bytes(&mut out, 2, &line(l));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Vec<Line> {
        vec![Line {
            text: "日本語".into(),
            bounding_box: Rect { x: 10, y: -2, width: 90, height: 30, angle: 0. },
            words: vec![Word {
                text: "日本語".into(),
                bounding_box: Rect { x: 10, y: -2, width: 90, height: 30, angle: 0. },
                symbols: vec![
                    Symbol { text: "日".into(), bounding_box: Rect { x: 10, y: 0, width: 30, height: 28, angle: 0. }, confidence: 0.9 },
                    Symbol { text: "本".into(), bounding_box: Rect { x: 40, y: 0, width: 30, height: 28, angle: 0. }, confidence: 0.8 },
                ],
                has_space_after: true,
                direction: Direction::LeftToRight,
                confidence: 0.75,
            }],
            language: "ja".into(),
            block_id: 3,
            paragraph_id: 1,
            direction: Direction::TopToBottom,
            content_type: 0,
            confidence: 0.5,
        }]
    }

    #[test]
    fn round_trips_every_field_kimochi_reads() {
        assert_eq!(decode(&encode::annotation(&sample())).unwrap(), sample());
    }

    #[test]
    fn negative_coordinates_keep_their_sign() {
        let lines = decode(&encode::annotation(&sample())).unwrap();
        assert_eq!(lines[0].bounding_box.y, -2);
    }

    #[test]
    fn unknown_fields_are_skipped() {
        // VisualAnnotation field 1 (a retired message) and a fixed64 field 9 in front of a line.
        let mut bytes = vec![0x0a, 0x02, 0x08, 0x01, 0x49, 1, 2, 3, 4, 5, 6, 7, 8];
        bytes.extend(encode::annotation(&sample()));
        assert_eq!(decode(&bytes).unwrap(), sample());
    }

    #[test]
    fn truncated_input_is_an_error_not_a_panic() {
        let bytes = encode::annotation(&sample());
        for cut in 1..bytes.len() {
            let _ = decode(&bytes[..cut]);
        }
        assert!(decode(&bytes[..bytes.len() - 1]).is_err());
    }

    #[test]
    fn rotated_bounds_cover_the_rotated_box() {
        let r = Rect { x: 100, y: 100, width: 40, height: 10, angle: 90. };
        let [x1, y1, x2, y2] = r.bounds();
        assert!((x1 - 90.).abs() < 1e-9 && (x2 - 100.).abs() < 1e-9);
        assert!((y1 - 100.).abs() < 1e-9 && (y2 - 140.).abs() < 1e-9);
    }
}

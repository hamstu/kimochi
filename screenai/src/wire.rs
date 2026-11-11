//! The private pipe between Kimochi and its Screen AI worker (stdin → worker, stdout → Kimochi).
//! Binary and length-prefixed, so a frame's pixels cross once with no encoding.
//!
//! ```text
//! request  := width:u32 height:u32 flags:u32 pixels[width*height*4]     (RGBA8, tightly packed)
//! reply    := kind:u8 length:u32 payload[length]
//!   kind 0 READY   payload = major:u32 minor:u32 max_dimension:u32       (once, after loading)
//!   kind 1 RESULT  payload = serialized VisualAnnotation
//!   kind 2 ERROR   payload = UTF-8 message                               (the worker carries on)
//! ```
//!
//! All integers are little-endian. A zero-sized request (width or height 0) asks the worker to
//! exit. `flags` bit 0 selects the library's light (smaller, faster) model.
use std::io::{self, Read, Write};

pub const READY: u8 = 0;
pub const RESULT: u8 = 1;
pub const ERROR: u8 = 2;

pub const FLAG_LIGHT: u32 = 1;

/// The largest payload either side accepts, far above any real frame (2048² RGBA is 16 MiB) or
/// result; a corrupt length must not allocate gigabytes.
pub const MAX_PAYLOAD: u32 = 64 << 20;

/// What the worker announces once the library is loaded and initialised.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ready {
    pub major: u32,
    pub minor: u32,
    /// The largest width or height the library reads; larger images must be scaled down first.
    pub max_dimension: u32,
}

impl Ready {
    pub fn version(&self) -> String {
        format!("{}.{}", self.major, self.minor)
    }
}

fn u32_le(bytes: &[u8]) -> u32 {
    u32::from_le_bytes(bytes[..4].try_into().unwrap())
}

/// One request's header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Request {
    pub width: u32,
    pub height: u32,
    pub flags: u32,
}

impl Request {
    pub fn pixel_bytes(&self) -> Result<usize, String> {
        let bytes = u64::from(self.width) * u64::from(self.height) * 4;
        if bytes > u64::from(MAX_PAYLOAD) {
            return Err(format!("image {}×{} is too large", self.width, self.height));
        }
        Ok(bytes as usize)
    }

    /// Write the header, then each row of `rows` (each exactly `width * 4` bytes).
    pub fn write<'a>(
        &self,
        out: &mut impl Write,
        rows: impl IntoIterator<Item = &'a [u8]>,
    ) -> io::Result<()> {
        let mut header = [0u8; 12];
        header[..4].copy_from_slice(&self.width.to_le_bytes());
        header[4..8].copy_from_slice(&self.height.to_le_bytes());
        header[8..].copy_from_slice(&self.flags.to_le_bytes());
        out.write_all(&header)?;
        let row_bytes = self.width as usize * 4;
        let mut count = 0u32;
        for row in rows {
            if row.len() != row_bytes {
                return Err(io::Error::new(io::ErrorKind::InvalidInput, "row has the wrong length"));
            }
            out.write_all(row)?;
            count += 1;
        }
        if count != self.height {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "wrong number of rows"));
        }
        out.flush()
    }

    /// Read a header; `None` at end of input.
    pub fn read(input: &mut impl Read) -> io::Result<Option<Self>> {
        let mut header = [0u8; 12];
        match input.read_exact(&mut header) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
            Err(e) => return Err(e),
        }
        Ok(Some(Self {
            width: u32_le(&header),
            height: u32_le(&header[4..]),
            flags: u32_le(&header[8..]),
        }))
    }
}

pub fn write_reply(out: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    let mut header = [0u8; 5];
    header[0] = kind;
    header[1..].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    out.write_all(&header)?;
    out.write_all(payload)?;
    out.flush()
}

pub fn ready_payload(ready: &Ready) -> [u8; 12] {
    let mut payload = [0u8; 12];
    payload[..4].copy_from_slice(&ready.major.to_le_bytes());
    payload[4..8].copy_from_slice(&ready.minor.to_le_bytes());
    payload[8..].copy_from_slice(&ready.max_dimension.to_le_bytes());
    payload
}

/// One reply as the host reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Ready(Ready),
    Result(Vec<u8>),
    Error(String),
}

pub fn read_reply(input: &mut impl Read) -> io::Result<Reply> {
    let mut header = [0u8; 5];
    input.read_exact(&mut header)?;
    let length = u32_le(&header[1..]);
    if length > MAX_PAYLOAD {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "reply too large"));
    }
    let mut payload = vec![0u8; length as usize];
    input.read_exact(&mut payload)?;
    match header[0] {
        READY if payload.len() == 12 => Ok(Reply::Ready(Ready {
            major: u32_le(&payload),
            minor: u32_le(&payload[4..]),
            max_dimension: u32_le(&payload[8..]),
        })),
        RESULT => Ok(Reply::Result(payload)),
        ERROR => Ok(Reply::Error(String::from_utf8_lossy(&payload).into_owned())),
        kind => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown reply kind {kind}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_round_trips_row_by_row() {
        let request = Request { width: 2, height: 2, flags: FLAG_LIGHT };
        let rows: [&[u8]; 2] = [&[1, 2, 3, 4, 5, 6, 7, 8], &[9, 10, 11, 12, 13, 14, 15, 16]];
        let mut bytes = Vec::new();
        request.write(&mut bytes, rows).unwrap();
        let mut input = bytes.as_slice();
        assert_eq!(Request::read(&mut input).unwrap(), Some(request));
        let mut pixels = vec![0; request.pixel_bytes().unwrap()];
        input.read_exact(&mut pixels).unwrap();
        assert_eq!(pixels, (1..=16).collect::<Vec<u8>>());
        assert_eq!(Request::read(&mut input).unwrap(), None);
    }

    #[test]
    fn a_short_row_is_refused() {
        let request = Request { width: 2, height: 1, flags: 0 };
        let rows: [&[u8]; 1] = [&[1, 2, 3]];
        assert!(request.write(&mut Vec::new(), rows).is_err());
    }

    #[test]
    fn replies_round_trip() {
        let ready = Ready { major: 153, minor: 7, max_dimension: 2048 };
        let mut bytes = Vec::new();
        write_reply(&mut bytes, READY, &ready_payload(&ready)).unwrap();
        write_reply(&mut bytes, RESULT, &[1, 2, 3]).unwrap();
        write_reply(&mut bytes, ERROR, "nope".as_bytes()).unwrap();
        let mut input = bytes.as_slice();
        assert_eq!(read_reply(&mut input).unwrap(), Reply::Ready(ready));
        assert_eq!(read_reply(&mut input).unwrap(), Reply::Result(vec![1, 2, 3]));
        assert_eq!(read_reply(&mut input).unwrap(), Reply::Error("nope".into()));
        assert!(read_reply(&mut input).is_err());
    }

    #[test]
    fn an_oversized_length_is_refused_without_allocating_it() {
        let bytes = [RESULT, 0xff, 0xff, 0xff, 0xff];
        assert!(read_reply(&mut bytes.as_slice()).is_err());
        let request = Request { width: 100_000, height: 100_000, flags: 0 };
        assert!(request.pixel_bytes().is_err());
    }
}

//! One-frame cache: identical pixels must not become different OCR observations.
//! Equality is byte-for-byte, including dimensions and source/crop identity.
use super::{Observation, ObserverStatus, TextObserver};
use crate::{Frame, Result};
use std::time::Duration;

pub struct CachedObserver {
    inner: Box<dyn TextObserver>,
    previous: Option<CachedRead>,
}

struct CachedRead {
    source: String,
    width: u32,
    height: u32,
    crop: [u32; 4],
    pixels: Vec<u8>,
    observation: Observation,
}

impl CachedObserver {
    pub fn new(inner: Box<dyn TextObserver>) -> Self {
        Self {
            inner,
            previous: None,
        }
    }
}

impl TextObserver for CachedObserver {
    fn status(&self) -> ObserverStatus {
        self.inner.status()
    }

    fn observe(&mut self, frame: &Frame, timeout: Duration) -> Result<Observation> {
        if let Some(previous) = &self.previous {
            if previous.source == frame.info.source_id
                && previous.width == frame.info.width
                && previous.height == frame.info.height
                && previous.crop == frame.info.crop_pixels
                && previous.pixels == frame.pixels
            {
                let mut cached = previous.observation.clone();
                cached.duration_ms = 0.0;
                return Ok(cached);
            }
        }
        // Do not reuse an earlier successful observation after a failed change.
        self.previous = None;
        let read = self.inner.observe(frame, timeout)?;
        self.previous = Some(CachedRead {
            source: frame.info.source_id.clone(),
            width: frame.info.width,
            height: frame.info.height,
            crop: frame.info.crop_pixels,
            pixels: frame.pixels.clone(),
            observation: read.clone(),
        });
        Ok(read)
    }

    fn close(&mut self) {
        self.previous = None;
        self.inner.close();
    }
}

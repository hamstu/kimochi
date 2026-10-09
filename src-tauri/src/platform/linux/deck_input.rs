//! Read-only physical Deck input alongside Steam's profile-dependent virtual pad.
//! No grabs, feature/output reports, controller mode changes or input injection.
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read};
use std::os::unix::fs::OpenOptionsExt;
use std::time::{Duration, Instant};

const BUTTONS: [(usize, u8); 17] = [
    (8, 7),
    (8, 5),
    (8, 6),
    (8, 4),
    (8, 3),
    (8, 2),
    (8, 1),
    (8, 0),
    (9, 4),
    (9, 6),
    (10, 6),
    (11, 2),
    (9, 0),
    (9, 3),
    (9, 2),
    (9, 1),
    (9, 5),
];

#[derive(Clone, Debug)]
pub struct Sample {
    pub buttons: Vec<bool>,
    pub axes: Vec<f64>,
    pub system_menu: bool,
}

// Protocol offsets correspond to Valve's Deck mapping in Linux hid-steam.c.
fn decode(report: &[u8]) -> Option<Sample> {
    if report.len() != 64 || report[..4] != [1, 0, 9, 64] {
        return None;
    }
    Some(Sample {
        system_menu: report[9] & (1 << 5) != 0 || report[14] & (1 << 2) != 0,
        buttons: BUTTONS
            .iter()
            .map(|&(offset, bit)| report[offset] & (1 << bit) != 0)
            .collect(),
        // HID stick Y is positive up, matching gilrs/navigation's convention.
        axes: [48, 50, 52, 54]
            .into_iter()
            .map(|offset| {
                let value = i16::from_le_bytes([report[offset], report[offset + 1]]);
                (f64::from(value) / 32767.0).clamp(-1.0, 1.0)
            })
            .collect(),
    })
}

pub struct Reader {
    file: Option<File>,
    sample: Option<Sample>,
    received: Option<Instant>,
    retry: Instant,
}

impl Reader {
    pub fn connected(&self) -> bool {
        self.received
            .is_some_and(|time| time.elapsed() < Duration::from_millis(250))
            && self.sample.is_some()
    }
    pub fn system_menu(&self) -> bool {
        self.connected()
            && self
                .sample
                .as_ref()
                .is_some_and(|sample| sample.system_menu)
    }
    pub fn new() -> Self {
        Self {
            file: None,
            sample: None,
            received: None,
            retry: Instant::now(),
        }
    }

    fn open(&mut self) {
        if !super::gamescope::active() || Instant::now() < self.retry {
            return;
        }
        self.retry = Instant::now() + Duration::from_secs(1);
        let Ok(entries) = fs::read_dir("/sys/class/hidraw") else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(info) = fs::read_to_string(entry.path().join("device/uevent")) else {
                continue;
            };
            // Match the Deck's raw controller interface, never keyboard/mouse or
            // an arbitrary hidraw index. Steam already owns this shared interface.
            if !info.lines().any(|l| l == "HID_ID=0003:000028DE:00001205")
                || !info
                    .lines()
                    .any(|l| l.starts_with("HID_PHYS=") && l.ends_with("/input2"))
            {
                continue;
            }
            if let Ok(file) = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(std::path::Path::new("/dev").join(entry.file_name()))
            {
                self.file = Some(file);
                break;
            }
        }
    }

    pub fn poll(&mut self) -> Option<Sample> {
        if self.file.is_none() {
            self.open();
        }
        let mut report = [0; 128];
        let mut disconnected = false;
        if let Some(file) = self.file.as_mut() {
            // Bound work even if reports arrive faster than this polling loop.
            for _ in 0..256 {
                match file.read(&mut report) {
                    Ok(0) => {
                        disconnected = true;
                        break;
                    }
                    Ok(size) => {
                        if let Some(sample) = decode(&report[..size]) {
                            self.sample = Some(sample);
                            self.received = Some(Instant::now());
                        }
                    }
                    Err(e) if e.kind() == ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                    Err(_) => {
                        disconnected = true;
                        break;
                    }
                }
            }
        }
        if disconnected {
            self.file = None;
            self.sample = None;
            self.received = None;
        }
        self.received
            .filter(|time| time.elapsed() < Duration::from_millis(250))
            .and(self.sample.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn steam_and_quick_access_request_system_handoff() {
        let mut r = report();
        assert!(!decode(&r).unwrap().system_menu);
        r[9] = 1 << 5;
        assert!(decode(&r).unwrap().system_menu);
        r[9] = 0;
        r[14] = 1 << 2;
        let sample = decode(&r).unwrap();
        assert!(sample.system_menu);
        assert!(!sample.buttons.contains(&true));
    }
    fn report() -> [u8; 64] {
        let mut r = [0; 64];
        r[..4].copy_from_slice(&[1, 0, 9, 64]);
        r
    }

    #[test]
    fn rejects_truncated_and_other_report_types() {
        for length in 0..64 {
            assert!(decode(&report()[..length]).is_none());
        }
        let mut r = report();
        r[2] = 1;
        assert!(decode(&r).is_none());
        let mut r = report();
        r[3] = 63;
        assert!(decode(&r).is_none());
    }

    #[test]
    fn physical_buttons_match_standard_order_and_release() {
        for (index, &(offset, bit)) in BUTTONS.iter().enumerate() {
            let mut r = report();
            r[offset] |= 1 << bit;
            let sample = decode(&r).unwrap();
            assert_eq!(sample.buttons.iter().position(|b| *b), Some(index));
            assert_eq!(sample.buttons.iter().filter(|b| **b).count(), 1);
        }
        assert!(!decode(&report()).unwrap().buttons.contains(&true));
    }

    #[test]
    fn sticks_preserve_up_and_bound_signed_extremes() {
        let mut r = report();
        for (offset, value) in [(48, i16::MIN), (50, i16::MAX), (52, 0), (54, -16384)] {
            r[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
        }
        let axes = decode(&r).unwrap().axes;
        assert_eq!(axes[..3], [-1.0, 1.0, 0.0]);
        assert!((axes[3] + 0.5).abs() < 0.001);
    }
}

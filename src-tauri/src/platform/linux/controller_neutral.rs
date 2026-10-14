//! Clear a held virtual gamepad report after the independent helper pauses Steam.
//! Never opens physical input devices, writes HID reports, or changes permissions.
use std::{
    fs::OpenOptions,
    io::Write,
    os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
    path::Path,
};

fn neutral(code: u16, min: i32, max: i32) -> Option<i32> {
    match code {
        2 | 5 => Some(min),
        0 | 1 | 3 | 4 => Some(if min < 0 && max > 0 {
            0
        } else {
            min + (max - min) / 2
        }),
        16 | 17 => Some(if min <= 0 && max >= 0 { 0 } else { min }),
        _ => None,
    }
}
fn eligible(bus: u16, vendor: u16, product: u16, path: &Path, name: &str) -> bool {
    bus == 3
        && vendor == 0x28de
        && product == 0x11ff
        && path.starts_with("/sys/devices/virtual/input")
        && name
            .strip_prefix("Microsoft X-Box 360 pad ")
            .is_some_and(|index| !index.is_empty() && index.bytes().all(|v| v.is_ascii_digit()))
}
fn query<T>(fd: i32, number: u64, value: &mut T) -> std::io::Result<()> {
    let request =
        0x8000_0000 | ((std::mem::size_of::<T>() as u64) << 16) | (u64::from(b'E') << 8) | number;
    if unsafe { libc::ioctl(fd, request as libc::c_ulong, value as *mut T) } < 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
#[repr(C)]
struct InputEvent {
    time: libc::timeval,
    kind: u16,
    code: u16,
    value: i32,
}
fn event(kind: u16, code: u16, value: i32) -> InputEvent {
    InputEvent {
        time: libc::timeval {
            tv_sec: 0,
            tv_usec: 0,
        },
        kind,
        code,
        value,
    }
}
pub(super) fn release() -> Result<(), String> {
    let result = || -> Result<usize, Box<dyn std::error::Error>> {
        let mut devices = 0;
        for node in std::fs::read_dir("/sys/class/input")?.flatten() {
            if !node.file_name().to_string_lossy().starts_with("event") {
                continue;
            }
            let path = node.path().join("device");
            let Ok(real) = path.canonicalize() else {
                continue;
            };
            if !real.starts_with("/sys/devices/virtual/input") {
                continue;
            }
            let name = std::fs::read_to_string(path.join("name"))?;
            if !name.trim().starts_with("Microsoft X-Box 360 pad ") {
                continue;
            }
            let mut file = OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(libc::O_NONBLOCK)
                .open(Path::new("/dev/input").join(node.file_name()))?;
            let fd = file.as_raw_fd();
            let mut id = [0_u16; 4];
            query(fd, 2, &mut id)?;
            if !eligible(id[0], id[1], id[2], &real, name.trim()) {
                continue;
            }
            let mut keys = [0_u8; 96];
            query(fd, 0x18, &mut keys)?;
            let mut events = Vec::new();
            for code in 256_u16..768 {
                if keys[usize::from(code / 8)] & (1 << (code % 8)) != 0 {
                    events.push(event(1, code, 0));
                }
            }
            let mut axes = 0_u64;
            query(fd, 0x23, &mut axes)?;
            for code in [0_u16, 1, 2, 3, 4, 5, 16, 17] {
                if axes & (1 << code) == 0 {
                    continue;
                }
                let mut info = [0_i32; 6];
                query(fd, 0x40 + u64::from(code), &mut info)?;
                if let Some(value) =
                    neutral(code, info[1], info[2]).filter(|value| *value != info[0])
                {
                    events.push(event(3, code, value));
                }
            }
            if !events.is_empty() {
                events.push(event(0, 0, 0));
                // repr(C), fully initialized fields, no padding on supported 64-bit Linux.
                let bytes = unsafe {
                    std::slice::from_raw_parts(
                        events.as_ptr().cast::<u8>(),
                        std::mem::size_of_val(events.as_slice()),
                    )
                };
                file.write_all(bytes)?;
            }
            devices += 1;
        }
        Ok(devices)
    };
    match result() {
        Ok(0) => Err("no writable Steam virtual gamepad found for neutral handoff".into()),
        Ok(count) => {
            eprintln!("Gamescope input: neutralized {count} Steam virtual gamepad(s)");
            Ok(())
        }
        Err(error) => Err(format!("Steam virtual controller neutral handoff: {error}")),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn controls_return_to_their_rest_values() {
        assert_eq!(neutral(0, -32767, 32767), Some(0));
        assert_eq!(neutral(1, 0, 65535), Some(32767));
        assert_eq!(neutral(2, 0, 255), Some(0));
        assert_eq!(neutral(17, -1, 1), Some(0));
        assert_eq!(neutral(30, 0, 255), None);
        assert_eq!(std::mem::size_of::<InputEvent>(), 24);
    }
    #[test]
    fn physical_and_unrelated_devices_are_never_targeted() {
        let path = Path::new("/sys/devices/virtual/input/input42");
        assert!(eligible(
            3,
            0x28de,
            0x11ff,
            path,
            "Microsoft X-Box 360 pad 0"
        ));
        assert!(!eligible(
            3,
            0x28de,
            0x1205,
            path,
            "Microsoft X-Box 360 pad 0"
        ));
        assert!(!eligible(
            3,
            0x28de,
            0x11ff,
            Path::new("/sys/devices/pci/input42"),
            "Microsoft X-Box 360 pad 0"
        ));
        assert!(!eligible(3, 0x28de, 0x11ff, path, "Keyboard"));
    }
}

//! Native Linux emulators use Agent; Windows games keep their own Wine prefix.
use super::{agent::index, process::Target, wine};
use std::io::Read;

fn x64_elf(bytes: &[u8]) -> bool {
    bytes.get(..6) == Some(b"\x7fELF\x02\x01") && bytes.get(18..20) == Some(&62u16.to_le_bytes())
}

pub fn target(pid: u32) -> Result<Target, String> {
    if pid == 0 || pid == std::process::id() {
        return Err("Kimochi and the system cannot be hooked".into());
    }
    let exe = std::fs::read_link(format!("/proc/{pid}/exe"))
        .map_err(|_| "this process is not running or cannot be inspected".to_string())?;
    if wine::is_wine_loader(&exe) {
        return wine::target(pid);
    }
    if !cfg!(target_arch = "x86_64") || index::emulator_platform(&exe).is_none() {
        return Err(
            "Native Linux text hooking supports x64 emulators with an Agent script; Windows games use Wine or Proton."
                .into(),
        );
    }
    let mut header = [0; 64];
    std::fs::File::open(&exe)
        .and_then(|mut f| f.read_exact(&mut header))
        .map_err(|_| "this emulator's executable cannot be inspected")?;
    if !x64_elf(&header) {
        return Err("Native Linux Agent scripts require an x64 ELF emulator.".into());
    }
    Ok(Target { pid, exe, bits: 64, wine: None })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_injector_requires_a_little_endian_x64_elf() {
        let mut header = [0; 64];
        header[..6].copy_from_slice(b"\x7fELF\x02\x01");
        header[18..20].copy_from_slice(&62u16.to_le_bytes());
        assert!(x64_elf(&header));
        header[18..20].copy_from_slice(&183u16.to_le_bytes());
        assert!(!x64_elf(&header));
        header[18..20].copy_from_slice(&62u16.to_le_bytes());
        header[4] = 1;
        assert!(!x64_elf(&header));
        assert!(!x64_elf(b"MZ"));
    }
}

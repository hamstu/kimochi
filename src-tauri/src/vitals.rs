//! What the machine and Kimochi were doing, every few seconds, while verbose logging is on
//! (`debug_report::heartbeat`): for reports of the whole computer freezing, where the last
//! records before the gap are all there is to go on.
//!
//! Linux reads `/proc`: Kimochi's own CPU and memory, its child processes' (the web views, the
//! OCR engines) by name, and the system's free memory, swap and memory pressure. Elsewhere a
//! sample is empty and the heartbeat carries only its timing and counts.
use serde_json::{json, Map, Value};

/// `utime + stime` (fields 14 and 15) and the parent pid (field 4) from `/proc/<pid>/stat`.
/// The command name (field 2) may hold spaces and parentheses, so fields count from its last `)`.
pub fn parse_stat(stat: &str) -> Option<(String, u32, u64)> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let name = stat.get(open + 1..close)?.to_string();
    let rest: Vec<&str> = stat.get(close + 1..)?.split_whitespace().collect();
    // rest[0] is field 3 (state), so field n is rest[n - 3].
    let ppid = rest.get(1)?.parse().ok()?;
    let utime: u64 = rest.get(11)?.parse().ok()?;
    let stime: u64 = rest.get(12)?.parse().ok()?;
    Some((name, ppid, utime + stime))
}

/// `VmRSS` and `Threads` from `/proc/<pid>/status`.
pub fn parse_status(status: &str) -> (u64, u64) {
    let field = |key: &str| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(key))
            .and_then(|rest| rest.split_whitespace().next()?.parse().ok())
            .unwrap_or(0)
    };
    (field("VmRSS:"), field("Threads:"))
}

/// The `/proc/meminfo` fields a freeze report needs, in MB.
pub fn parse_meminfo(meminfo: &str) -> Value {
    let kb = |key: &str| {
        meminfo
            .lines()
            .find_map(|line| line.strip_prefix(key)?.strip_prefix(':'))
            .and_then(|rest| rest.split_whitespace().next()?.parse::<u64>().ok())
    };
    let mb = |key: &str| kb(key).map(|v| v / 1024);
    json!({
        "totalMb": mb("MemTotal"),
        "availableMb": mb("MemAvailable"),
        "swapTotalMb": mb("SwapTotal"),
        "swapFreeMb": mb("SwapFree"),
    })
}

/// `avg10` of the `some` line of `/proc/pressure/<resource>`: the share of the last ten seconds
/// in which at least one task waited on it. Memory pressure climbing toward 100 is a machine
/// thrashing on swap.
pub fn parse_pressure(pressure: &str) -> Option<f64> {
    pressure
        .lines()
        .find(|line| line.starts_with("some"))?
        .split_whitespace()
        .find_map(|field| field.strip_prefix("avg10="))?
        .parse()
        .ok()
}

/// CPU use between two readings, as a percentage of one core (400 is four cores flat out).
pub fn cpu_percent(before: u64, after: u64, elapsed_ms: u64, ticks_per_second: u64) -> u64 {
    if elapsed_ms == 0 || after < before {
        return 0;
    }
    (after - before) * 100_000 / ticks_per_second.max(1) / elapsed_ms
}

/// Takes samples and remembers the previous one, so each reports CPU since the last.
#[derive(Default)]
pub struct Sampler {
    previous: Option<Reading>,
}

/// When a sample was taken, and each process's CPU ticks then, by pid.
type Reading = (std::time::Instant, std::collections::HashMap<u32, u64>);

impl Sampler {
    /// Kimochi and its children, and the system, now; `Value::Null` where `/proc` isn't.
    #[cfg(target_os = "linux")]
    pub fn sample(&mut self) -> Value {
        use std::collections::HashMap;
        let read = |path: &str| std::fs::read_to_string(path).ok();
        let me = std::process::id();
        let now = std::time::Instant::now();
        // Kimochi and its direct children: the web views and engines it started.
        let mut processes: HashMap<u32, (String, u64, u64, u64)> = HashMap::new();
        if let Ok(entries) = std::fs::read_dir("/proc") {
            for entry in entries.flatten() {
                let Some(pid) = entry.file_name().to_str().and_then(|n| n.parse::<u32>().ok()) else { continue };
                let Some((name, ppid, ticks)) = read(&format!("/proc/{pid}/stat")).as_deref().and_then(parse_stat) else {
                    continue;
                };
                if pid != me && ppid != me {
                    continue;
                }
                let (rss, threads) = read(&format!("/proc/{pid}/status")).as_deref().map_or((0, 0), parse_status);
                processes.insert(pid, (name, ticks, rss, threads));
            }
        }
        let elapsed = self.previous.as_ref().map(|(at, _)| now.duration_since(*at).as_millis() as u64);
        let cpu = |pid: u32, ticks: u64| -> Option<u64> {
            let before = self.previous.as_ref()?.1.get(&pid)?;
            Some(cpu_percent(*before, ticks, elapsed?, 100))
        };
        let mut children: Map<String, Value> = Map::new();
        let mut own = json!(null);
        for (&pid, (name, ticks, rss, threads)) in &processes {
            let entry = json!({ "cpu": cpu(pid, *ticks), "rssMb": rss / 1024, "threads": threads });
            if pid == me {
                own = entry;
            } else {
                // Several web views share a name: summed, with how many there are.
                let slot = children.entry(name.clone()).or_insert_with(|| json!({ "n": 0, "cpu": 0, "rssMb": 0 }));
                slot["n"] = json!(slot["n"].as_u64().unwrap_or(0) + 1);
                slot["cpu"] = json!(slot["cpu"].as_u64().unwrap_or(0) + cpu(pid, *ticks).unwrap_or(0));
                slot["rssMb"] = json!(slot["rssMb"].as_u64().unwrap_or(0) + rss / 1024);
            }
        }
        self.previous = Some((now, processes.iter().map(|(&pid, (_, ticks, ..))| (pid, *ticks)).collect()));
        let load: Vec<f64> = read("/proc/loadavg")
            .map(|l| l.split_whitespace().take(3).filter_map(|v| v.parse().ok()).collect())
            .unwrap_or_default();
        json!({
            "kimochi": own,
            "children": children,
            "memory": read("/proc/meminfo").as_deref().map_or(json!(null), parse_meminfo),
            "pressure": {
                "memory": read("/proc/pressure/memory").as_deref().and_then(parse_pressure),
                "cpu": read("/proc/pressure/cpu").as_deref().and_then(parse_pressure),
                "io": read("/proc/pressure/io").as_deref().and_then(parse_pressure),
            },
            "load": load,
        })
    }

    #[cfg(not(target_os = "linux"))]
    pub fn sample(&mut self) -> Value {
        let _ = &self.previous;
        Value::Null
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_fields_count_from_the_last_parenthesis() {
        let stat = "4242 (Web (Content) x) S 4000 4242 4242 0 -1 4194560 100 0 0 0 1500 250 0 0 20 0 30 0 99 0 0";
        assert_eq!(parse_stat(stat), Some(("Web (Content) x".into(), 4000, 1750)));
        assert_eq!(parse_stat("garbage"), None);
    }

    #[test]
    fn status_meminfo_and_pressure_are_read() {
        assert_eq!(parse_status("Name:\tk\nVmRSS:\t  204800 kB\nThreads:\t31\n"), (204800, 31));
        let mem = parse_meminfo("MemTotal:       16000000 kB\nMemAvailable:    1024000 kB\nSwapTotal: 1048576 kB\nSwapFree: 0 kB\n");
        assert_eq!(mem["totalMb"], 15625);
        assert_eq!(mem["availableMb"], 1000);
        assert_eq!(mem["swapFreeMb"], 0);
        let pressure = "some avg10=42.50 avg60=10.00 avg300=1.00 total=1\nfull avg10=5.00 avg60=0 avg300=0 total=1\n";
        assert_eq!(parse_pressure(pressure), Some(42.5));
        assert_eq!(parse_pressure(""), None);
    }

    #[test]
    fn cpu_is_a_share_of_one_core() {
        // 1000 ticks at 100 a second over 5 s: two cores' worth.
        assert_eq!(cpu_percent(0, 1000, 5000, 100), 200);
        assert_eq!(cpu_percent(10, 5, 5000, 100), 0);
        assert_eq!(cpu_percent(0, 10, 0, 100), 0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_sample_finds_this_process() {
        let mut sampler = Sampler::default();
        sampler.sample();
        let second = sampler.sample();
        assert!(second["kimochi"]["rssMb"].as_u64().is_some());
        assert!(second["kimochi"]["cpu"].as_u64().is_some());
        assert!(second["memory"]["totalMb"].as_u64().is_some_and(|mb| mb > 0));
    }
}

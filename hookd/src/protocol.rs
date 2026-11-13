//! The line protocol between Kimochi and this sidecar: JSON commands on stdin, JSON events on
//! stdout, one object per line. Both directions are documented in COMMANDS.md ("Text Hooker
//! sidecar"). Everything here is platform-neutral so it is tested on every OS.
use serde_json::{json, Value};
use std::io::Write;
use std::sync::Mutex;

/// One text thread's identity inside a process, as both engines report it: the hook address and
/// its two context values. `key` is how the app names a thread for the life of an attach.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Thread {
    pub pid: u32,
    pub addr: u64,
    pub ctx: u64,
    pub ctx2: u64,
}

impl Thread {
    pub fn key(&self) -> String {
        format!("{}:{:x}:{:x}:{:x}", self.pid, self.addr, self.ctx, self.ctx2)
    }
    pub fn fields(&self) -> Value {
        json!({
            "key": self.key(),
            "pid": self.pid,
            "addr": format!("{:x}", self.addr),
            "ctx": format!("{:x}", self.ctx),
            "ctx2": format!("{:x}", self.ctx2),
        })
    }
}

static OUT: Mutex<()> = Mutex::new(());

/// Writes one event line. Engine callbacks arrive on their own threads, so writes are serialised.
pub fn emit(event: &str, mut fields: Value) {
    if let Value::Object(map) = &mut fields {
        map.insert("event".into(), Value::String(event.into()));
    }
    let _guard = OUT.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{fields}");
    let _ = out.flush();
}

pub fn thread_event(event: &str, thread: &Thread, hookcode: &str, name: &str) {
    let mut fields = thread.fields();
    fields["hookcode"] = hookcode.into();
    fields["name"] = name.into();
    emit(event, fields);
}

#[derive(Debug, PartialEq)]
pub enum Command {
    /// Attach to a process. `bits` is the image's bitness read by the app from the PE header;
    /// the sidecar retries the other bitness if the first injection never connects.
    Attach {
        pid: u32,
        bits: u32,
        pc_hooks: PcHooks,
    },
    Detach {
        pid: u32,
    },
    /// Insert an H-code (Luna and Textractor share the syntax for the common cases).
    Insert {
        pid: u32,
        code: String,
    },
    /// Insert the generic Windows API hooks (GDI text calls and friends).
    PcHooks {
        pid: u32,
    },
    /// Decode multibyte (ANSI) text whose hook names no code page with this one from now on (the
    /// language being read changed). Only sent to a helper whose `ready` carried `codepage`.
    CodePage {
        codepage: u32,
    },
    Quit,
}

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum PcHooks {
    /// Insert the generic API hooks only when engine detection names no engine.
    Auto,
    On,
    Off,
}

pub fn parse_command(line: &str) -> Result<Command, String> {
    let value: Value = serde_json::from_str(line).map_err(|e| format!("bad command: {e}"))?;
    let pid =
        || value["pid"].as_u64().and_then(|p| u32::try_from(p).ok()).ok_or_else(|| "command needs a pid".to_string());
    match value["cmd"].as_str().unwrap_or("") {
        "attach" => Ok(Command::Attach {
            pid: pid()?,
            bits: match value["bits"].as_u64() {
                Some(32) => 32,
                _ => 64,
            },
            pc_hooks: match value["pcHooks"].as_str() {
                Some("on") => PcHooks::On,
                Some("off") => PcHooks::Off,
                _ => PcHooks::Auto,
            },
        }),
        "detach" => Ok(Command::Detach { pid: pid()? }),
        "insert" => Ok(Command::Insert {
            pid: pid()?,
            code: value["code"]
                .as_str()
                .filter(|c| !c.trim().is_empty())
                .ok_or("insert needs a code")?
                .trim()
                .to_string(),
        }),
        "pchooks" => Ok(Command::PcHooks { pid: pid()? }),
        "codepage" => Ok(Command::CodePage {
            codepage: value["codepage"]
                .as_u64()
                .and_then(|c| u32::try_from(c).ok())
                .filter(|c| *c > 0)
                .ok_or("codepage needs a code page")?,
        }),
        "quit" => Ok(Command::Quit),
        other => Err(format!("unknown command {other:?}")),
    }
}

/// Shift-JIS: the code page LunaHook decodes multibyte text with unless told otherwise, and what
/// an app from before languages (which passes no `--codepage`) still gets.
pub const DEFAULT_CODE_PAGE: u32 = 932;

/// The `--codepage` argument of `luna`, else [`DEFAULT_CODE_PAGE`].
#[cfg_attr(not(windows), allow(dead_code))]
pub fn code_page_arg(args: &[String]) -> u32 {
    args.iter()
        .position(|a| a == "--codepage")
        .and_then(|i| args.get(i + 1))
        .and_then(|v| v.parse::<u32>().ok())
        .filter(|c| *c > 0)
        .unwrap_or(DEFAULT_CODE_PAGE)
}

/// One line of TextractorCLI output: `[handle:pid:addr:ctx:ctx2:name:hookcode] text`.
/// Hook codes contain colons (`HW-4@0:gdi32.dll:GetGlyphOutlineW`) and hook names do not, so the
/// name ends at the first colon after the fixed fields and the rest is the hook code. Textractor's
/// own Console and Clipboard threads (pid 0) are not text from the game and are dropped.
#[derive(Debug, PartialEq)]
pub struct TextractorLine {
    pub thread: Thread,
    pub name: String,
    pub hookcode: String,
    pub text: String,
}

pub fn parse_textractor_line(line: &str) -> Option<TextractorLine> {
    let rest = line.strip_prefix('[')?;
    let close = rest.find("] ")?;
    let (header, text) = (&rest[..close], &rest[close + 2..]);
    let mut left = header.splitn(6, ':');
    let _handle = left.next()?;
    let pid = u32::from_str_radix(left.next()?, 16).ok()?;
    let addr = u64::from_str_radix(left.next()?, 16).ok()?;
    let ctx = u64::from_str_radix(left.next()?, 16).ok()?;
    let ctx2 = u64::from_str_radix(left.next()?, 16).ok()?;
    let (name, hookcode) = left.next()?.split_once(':')?;
    if pid == 0 {
        return None;
    }
    Some(TextractorLine {
        thread: Thread { pid, addr, ctx, ctx2 },
        name: name.to_string(),
        hookcode: hookcode.to_string(),
        text: text.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attach_defaults_to_64_bit_and_auto_pc_hooks() {
        assert_eq!(
            parse_command(r#"{"cmd":"attach","pid":42}"#),
            Ok(Command::Attach { pid: 42, bits: 64, pc_hooks: PcHooks::Auto })
        );
        assert_eq!(
            parse_command(r#"{"cmd":"attach","pid":42,"bits":32,"pcHooks":"on"}"#),
            Ok(Command::Attach { pid: 42, bits: 32, pc_hooks: PcHooks::On })
        );
    }

    #[test]
    fn a_code_page_change_names_the_code_page() {
        assert_eq!(parse_command(r#"{"cmd":"codepage","codepage":949}"#), Ok(Command::CodePage { codepage: 949 }));
        assert!(parse_command(r#"{"cmd":"codepage"}"#).is_err());
        assert!(parse_command(r#"{"cmd":"codepage","codepage":0}"#).is_err());
        assert!(parse_command(r#"{"cmd":"codepage","codepage":"949"}"#).is_err());
    }

    #[test]
    fn the_code_page_argument_defaults_to_shift_jis() {
        let args = |s: &str| s.split(' ').map(str::to_string).collect::<Vec<_>>();
        assert_eq!(code_page_arg(&args("luna --dir x --flush-ms 400")), 932);
        assert_eq!(code_page_arg(&args("luna --dir x --codepage 1251")), 1251);
        assert_eq!(code_page_arg(&args("luna --dir x --codepage 0")), 932);
        assert_eq!(code_page_arg(&args("luna --dir x --codepage nope")), 932);
    }

    #[test]
    fn commands_without_a_pid_or_code_are_refused() {
        assert!(parse_command(r#"{"cmd":"detach"}"#).is_err());
        assert!(parse_command(r#"{"cmd":"insert","pid":1,"code":"  "}"#).is_err());
        assert!(parse_command(r#"{"cmd":"nope"}"#).is_err());
        assert!(parse_command("not json").is_err());
    }

    #[test]
    fn textractor_lines_split_on_the_outer_colons() {
        let line =
            parse_textractor_line("[3:1a2c:7ff6a000:1234:0:GetGlyphOutlineW:HW-4@0:gdi32.dll:GetGlyphOutlineW] 今日は")
                .expect("parsed");
        assert_eq!(line.thread, Thread { pid: 0x1a2c, addr: 0x7ff6a000, ctx: 0x1234, ctx2: 0 });
        assert_eq!(line.name, "GetGlyphOutlineW");
        assert_eq!(line.hookcode, "HW-4@0:gdi32.dll:GetGlyphOutlineW");
        assert_eq!(line.text, "今日は");
        assert_eq!(line.thread.key(), "6700:7ff6a000:1234:0");
    }

    #[test]
    fn console_lines_are_not_text() {
        assert_eq!(parse_textractor_line("Textractor: pipe connected"), None);
        assert_eq!(parse_textractor_line("[0:0:0:0:0:Console:] attached"), None);
    }
}

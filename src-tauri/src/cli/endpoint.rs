//! Where the running app listens for the command line, and the folders both sides read.
//!
//! The app writes `cli-endpoint.json` (`cli-endpoint-dev.json` for a development build) to its
//! data folder when it starts: the loopback port it accepts commands on, a random token every
//! request must carry, its pid and version. The file is private to the user (0600 on macOS and
//! Linux; `%APPDATA%` is the user's own on Windows), so the token is what keeps other users'
//! processes on the same machine out. The protocol is one JSON request line per connection,
//! answered by one JSON line (or, for `watch`, a stream of them), never HTTP: a web page cannot
//! speak it, whatever it sends to the port.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::time::Duration;

/// `tauri.conf.json`'s identifier: the data folders are named after it (a test keeps them equal).
pub const IDENTIFIER: &str = "dev.kimochi.app";
/// This build's flavor, and the other one's: a release CLI can drive a development app (macOS
/// runs one Kimochi at a time, so there is never a choice to make there).
pub const FLAVOR: &str = if cfg!(dev) { "dev" } else { "release" };
/// The largest request accepted, in bytes (a `log add` of a long passage fits easily).
pub const MAX_REQUEST: u64 = 1024 * 1024;
/// Bumped when a request or reply changes shape incompatibly.
pub const PROTOCOL: u32 = 1;

fn file_name(flavor: &str) -> &'static str {
    if flavor == "dev" {
        "cli-endpoint-dev.json"
    } else {
        "cli-endpoint.json"
    }
}

/// The app's data folder, as Tauri's `app_data_dir()` names it, without an app to ask.
pub fn data_dir() -> Option<PathBuf> {
    #[cfg(not(target_os = "windows"))]
    let home = || std::env::var_os("HOME").map(PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = home().map(|h| h.join("Library/Application Support"));
    #[cfg(target_os = "windows")]
    let base = std::env::var_os("APPDATA").map(PathBuf::from);
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .or_else(|| home().map(|h| h.join(".local/share")));
    base.map(|b| b.join(IDENTIFIER))
}

/// The app's local data folder (`app_local_data_dir()`): the Log, sessions and models.
pub fn local_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA").map(|b| PathBuf::from(b).join(IDENTIFIER))
    }
    #[cfg(not(target_os = "windows"))]
    {
        data_dir()
    }
}

/// The folder of the profile in use: the Local profile, or a signed-in account's.
pub fn profile_dir() -> Option<PathBuf> {
    Some(crate::account::profile_dir_offline(&data_dir()?, &local_dir()?))
}

/// What the app publishes about its command listener.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub version: String,
    pub flavor: String,
    #[serde(default)]
    pub protocol: u32,
}

pub fn endpoint_path(flavor: &str) -> Option<PathBuf> {
    Some(data_dir()?.join(file_name(flavor)))
}

/// The endpoints to try, this build's flavor first.
pub fn candidates() -> Vec<Endpoint> {
    let other = if FLAVOR == "dev" { "release" } else { "dev" };
    [FLAVOR, other]
        .iter()
        .filter_map(|flavor| endpoint_path(flavor))
        .filter_map(|path| std::fs::read(path).ok())
        .filter_map(|bytes| serde_json::from_slice(&bytes).ok())
        .collect()
}

/// A request as it goes over the wire.
#[derive(Debug, Serialize, Deserialize)]
pub struct Request {
    pub token: String,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// An open request: the reply lines are read from `reader`.
pub struct Connection {
    pub reader: BufReader<TcpStream>,
}

impl Connection {
    /// The next reply line, parsed; `None` once the app closed the connection.
    pub fn next(&mut self) -> Option<Result<Value, CallError>> {
        let mut line = String::new();
        match self.reader.read_line(&mut line) {
            Ok(0) => None,
            Ok(_) => Some(serde_json::from_str(&line).map_err(|e| CallError::Failed(format!("bad reply from Kimochi: {e}")))),
            Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {
                Some(Err(CallError::Timeout))
            }
            Err(e) => Some(Err(CallError::Unreachable(format!("lost the connection to Kimochi: {e}")))),
        }
    }
}

/// Send one request. `timeout` bounds connecting and each read (`None` waits forever, for streams).
pub fn send(endpoint: &Endpoint, method: &str, params: Value, timeout: Option<Duration>) -> Result<Connection, String> {
    let address = SocketAddr::from(([127, 0, 0, 1], endpoint.port));
    let stream = TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    stream.set_read_timeout(timeout).map_err(|e| e.to_string())?;
    let _ = stream.set_nodelay(true);
    let request = Request { token: endpoint.token.clone(), method: method.to_string(), params };
    let mut line = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    line.push(b'\n');
    (&stream).write_all(&line).map_err(|e| e.to_string())?;
    Ok(Connection { reader: BufReader::new(stream) })
}

/// Send one request and wait for its single reply: the result, or the app's error message.
pub fn call(endpoint: &Endpoint, method: &str, params: Value, timeout: Duration) -> Result<Value, CallError> {
    let mut connection = send(endpoint, method, params, Some(timeout)).map_err(CallError::Unreachable)?;
    match connection.next() {
        None => Err(CallError::Unreachable("Kimochi closed the connection".into())),
        Some(Err(e)) => Err(e),
        Some(Ok(reply)) => {
            if reply["ok"] == Value::Bool(true) {
                Ok(reply.get("result").cloned().unwrap_or(Value::Null))
            } else {
                Err(CallError::Failed(reply["error"].as_str().unwrap_or("Kimochi refused the request").to_string()))
            }
        }
    }
}

#[derive(Debug)]
pub enum CallError {
    /// Nothing answered: the app is not running (or not this one).
    Unreachable(String),
    /// The app answered with an error.
    Failed(String),
    Timeout,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_identifier_is_the_apps() {
        let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], IDENTIFIER);
    }

    /// A stand-in app: answers each request with `answer(request)`.
    fn fake_app(answer: fn(&Request) -> Value) -> Endpoint {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut line = String::new();
                BufReader::new(&stream).read_line(&mut line).unwrap();
                let request: Request = serde_json::from_str(&line).unwrap();
                let mut reply = serde_json::to_vec(&answer(&request)).unwrap();
                reply.push(b'\n');
                (&stream).write_all(&reply).unwrap();
            }
        });
        Endpoint { port, token: "secret".into(), pid: 1, version: "0".into(), flavor: "dev".into(), protocol: PROTOCOL }
    }

    #[test]
    fn a_call_carries_the_token_and_returns_the_result_or_the_apps_error() {
        let app = fake_app(|request| {
            if request.token != "secret" {
                return serde_json::json!({"ok": false, "error": "invalid: wrong token"});
            }
            match request.method.as_str() {
                "echo" => serde_json::json!({"ok": true, "result": request.params}),
                _ => serde_json::json!({"ok": false, "error": "invalid: unknown method"}),
            }
        });
        let result = call(&app, "echo", serde_json::json!({"text": "猫"}), Duration::from_secs(5)).unwrap();
        assert_eq!(result["text"], "猫");
        match call(&app, "nope", Value::Null, Duration::from_secs(5)) {
            Err(CallError::Failed(message)) => assert_eq!(message, "invalid: unknown method"),
            other => panic!("{other:?}"),
        }
        let wrong = Endpoint { token: "guess".into(), ..app.clone() };
        assert!(matches!(call(&wrong, "echo", Value::Null, Duration::from_secs(5)), Err(CallError::Failed(_))));
    }

    #[test]
    fn nothing_listening_is_unreachable() {
        let port = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap().local_addr().unwrap().port();
        let gone = Endpoint { port, token: "x".into(), pid: 1, version: "0".into(), flavor: "dev".into(), protocol: PROTOCOL };
        assert!(matches!(call(&gone, "ping", Value::Null, Duration::from_secs(1)), Err(CallError::Unreachable(_))));
    }

    #[test]
    fn each_flavor_has_its_own_endpoint_file() {
        assert_ne!(file_name("dev"), file_name("release"));
    }
}

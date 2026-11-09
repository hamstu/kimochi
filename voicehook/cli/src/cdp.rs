//! A minimal Chrome DevTools Protocol client (localhost HTTP + WebSocket, no TLS), enough to put
//! `web.js` into the pages of an Electron game started with `--remote-debugging-port`.
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

fn http_get(port: u16, path: &str) -> Result<String, String> {
    let mut s = TcpStream::connect(("127.0.0.1", port)).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(2))).ok();
    write!(s, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n").map_err(|e| e.to_string())?;
    // Read until the server closes or goes quiet (DevTools may keep the connection open).
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    while let Ok(n) = s.read(&mut chunk) {
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    let text = String::from_utf8_lossy(&buf).into_owned();
    Ok(text.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default())
}

/// The pages' WebSocket URLs, once the port answers (waits up to `wait`).
pub fn pages(port: u16, wait: Duration) -> Result<Vec<String>, String> {
    let until = Instant::now() + wait;
    loop {
        if let Ok(body) = http_get(port, "/json/list") {
            if let Ok(Value::Array(list)) = serde_json::from_str::<Value>(body.trim()) {
                let urls: Vec<String> = list
                    .iter()
                    .filter(|p| p["type"] == "page")
                    .filter_map(|p| p["webSocketDebuggerUrl"].as_str().map(str::to_string))
                    .collect();
                if !urls.is_empty() {
                    return Ok(urls);
                }
            }
        }
        if Instant::now() > until {
            return Err(format!("no DevTools page on port {port} (remote debugging disabled in this build?)"));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

pub struct Ws {
    s: BufReader<TcpStream>,
    next_id: u64,
}

impl Ws {
    pub fn connect(url: &str) -> Result<Ws, String> {
        let rest = url.strip_prefix("ws://").ok_or("not a ws:// URL")?;
        let (host, path) = rest.split_once('/').ok_or("bad ws URL")?;
        let mut s = TcpStream::connect(host).map_err(|e| e.to_string())?;
        s.set_read_timeout(Some(Duration::from_secs(10))).ok();
        write!(
            s,
            "GET /{path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dm9pY2Vob29rLXZvaWNlaA==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        .map_err(|e| e.to_string())?;
        let mut r = BufReader::new(s);
        let mut status = String::new();
        r.read_line(&mut status).map_err(|e| e.to_string())?;
        if !status.contains(" 101") {
            return Err(format!("WebSocket upgrade refused: {}", status.trim()));
        }
        loop {
            let mut l = String::new();
            r.read_line(&mut l).map_err(|e| e.to_string())?;
            if l == "\r\n" || l.is_empty() {
                break;
            }
        }
        Ok(Ws { s: r, next_id: 1 })
    }

    fn send_text(&mut self, text: &str) -> Result<(), String> {
        let p = text.as_bytes();
        let mut f = vec![0x81u8];
        match p.len() {
            n if n < 126 => f.push(0x80 | n as u8),
            n if n < 65536 => {
                f.push(0x80 | 126);
                f.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                f.push(0x80 | 127);
                f.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        let mask = [0x5au8, 0x13, 0xc7, 0x2e];
        f.extend_from_slice(&mask);
        f.extend(p.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.s.get_mut().write_all(&f).map_err(|e| e.to_string())
    }

    fn read_message(&mut self) -> Result<String, String> {
        let mut msg = Vec::new();
        loop {
            let mut h = [0u8; 2];
            self.s.read_exact(&mut h).map_err(|e| e.to_string())?;
            let fin = h[0] & 0x80 != 0;
            let op = h[0] & 0x0f;
            let mut len = (h[1] & 0x7f) as u64;
            if len == 126 {
                let mut b = [0u8; 2];
                self.s.read_exact(&mut b).map_err(|e| e.to_string())?;
                len = u16::from_be_bytes(b) as u64;
            } else if len == 127 {
                let mut b = [0u8; 8];
                self.s.read_exact(&mut b).map_err(|e| e.to_string())?;
                len = u64::from_be_bytes(b);
            }
            let mut data = vec![0u8; len as usize];
            self.s.read_exact(&mut data).map_err(|e| e.to_string())?;
            if op == 8 {
                return Err("closed".into());
            }
            if op == 9 || op == 10 {
                continue; // ping/pong
            }
            msg.extend_from_slice(&data);
            if fin {
                return Ok(String::from_utf8_lossy(&msg).into_owned());
            }
        }
    }

    /// Sends a command and returns its result (events in between are skipped).
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.send_text(&json!({"id": id, "method": method, "params": params}).to_string())?;
        loop {
            let m: Value = serde_json::from_str(&self.read_message()?).map_err(|e| e.to_string())?;
            if m["id"].as_u64() == Some(id) {
                if let Some(e) = m.get("error") {
                    return Err(format!("{method}: {e}"));
                }
                return Ok(m["result"].clone());
            }
        }
    }
}

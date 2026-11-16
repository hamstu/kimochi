//! Audio around a pause on Linux. A game that talks to PipeWire directly (its own client and
//! stream nodes, as some newer audio libraries do) holds up the whole graph while it is stopped:
//! the driver waits for its node every cycle, so every other app on the same output goes silent
//! (or loops its last buffer on hardware) until the game runs again. Games that go through the
//! PulseAudio protocol (Wine/Proton, most audio libraries by default) are not affected: `pipewire-pulse` is the
//! PipeWire client there and keeps running.
//!
//! So before the game stops, each of its playback streams is moved ("parked") to a null sink of its
//! own, which no other app uses, and after the game runs again it is moved back:
//! - The park sink is created by a `pw-cli` child of the process that holds the pause (the guard),
//!   as a node that does not outlive that client. The child is killed on unpark, and gets SIGTERM
//!   when the guard dies (`PR_SET_PDEATHSIG`), so the sink never outlives the pause.
//! - The move is a `target.object` entry in PipeWire's `default` metadata. What was there before
//!   is saved next to it, under [`RESTORE_KEY`] on the same node, so any process can put it back
//!   (the guard on resume, or a later guard or the app recovering from the journal) without
//!   anything else persisted. PipeWire drops both entries itself when the stream ends.
//! - Everything here is best effort: without PipeWire's command line tools (`pw-dump`, `pw-cli`,
//!   `pw-metadata`) it is skipped (said once), every command has a time limit, and no failure here
//!   ever fails a pause or a resume.
use serde_json::Value;
use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

/// The metadata key, on a parked stream node, that holds what to put back.
pub const RESTORE_KEY: &str = "kimochi.pause.restore";
/// The park sinks' node name prefix (`<prefix>-<pid of the process that owns it>`).
pub const PARK_PREFIX: &str = "kimochi-pause-park";
/// The routing keys a move changes (both are honoured by the session manager).
const TARGET_KEYS: &[&str] = &["target.object", "target.node"];
const COMMAND_LIMIT: Duration = Duration::from_secs(2);
const SETTLE: Duration = Duration::from_millis(1000);

static SAID_UNAVAILABLE: AtomicBool = AtomicBool::new(false);

/// One step, for the log.
pub type Steps = Vec<String>;

/// A game's playback stream node.
#[derive(Clone, Debug, PartialEq)]
pub struct Stream {
    pub node: u32,
    pub name: String,
    pub pid: u32,
}

/// One entry of a metadata object.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub subject: u32,
    pub key: String,
    pub value: String,
    pub kind: String,
}

/// A `pw-metadata` change: set (`Some(value, type)`) or delete (`None`) `key` on `subject`.
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    pub subject: u32,
    pub key: String,
    pub set: Option<(String, String)>,
}

// ---- reading `pw-dump` (pure) ----

fn props(object: &Value) -> &Value {
    &object["info"]["props"]
}
fn kind(object: &Value) -> &str {
    object["type"].as_str().unwrap_or_default().rsplit(':').next().unwrap_or_default()
}
fn as_u32(value: &Value) -> Option<u32> {
    value.as_u64().and_then(|v| u32::try_from(v).ok()).or_else(|| value.as_str()?.parse().ok())
}

/// The playback streams whose PipeWire client is one of `pids` (the client's pid as the server saw
/// it on the socket, so a sandboxed game's host pid).
pub fn game_streams(dump: &Value, pids: &[u32]) -> Vec<Stream> {
    let Some(objects) = dump.as_array() else { return Vec::new() };
    let clients: Vec<(u32, u32)> = objects
        .iter()
        .filter(|o| kind(o) == "Client")
        .filter_map(|o| {
            let p = props(o);
            let pid = as_u32(&p["pipewire.sec.pid"]).or_else(|| as_u32(&p["application.process.id"]))?;
            Some((as_u32(&o["id"])?, pid))
        })
        .filter(|(_, pid)| pids.contains(pid))
        .collect();
    let mut out: Vec<Stream> = objects
        .iter()
        .filter(|o| kind(o) == "Node")
        .filter(|o| props(o)["media.class"].as_str() == Some("Stream/Output/Audio"))
        .filter_map(|o| {
            let client = as_u32(&props(o)["client.id"])?;
            let (_, pid) = clients.iter().find(|(id, _)| *id == client)?;
            let name = props(o)["node.name"].as_str().unwrap_or_default().to_string();
            Some(Stream { node: as_u32(&o["id"])?, name, pid: *pid })
        })
        .collect();
    out.sort_by_key(|s| s.node);
    out
}

/// The entries of the metadata object named `name` (`default`).
pub fn metadata(dump: &Value, name: &str) -> Vec<Entry> {
    let Some(objects) = dump.as_array() else { return Vec::new() };
    objects
        .iter()
        // `pw-dump` puts a metadata object's name in its top-level `props`.
        .filter(|o| {
            kind(o) == "Metadata"
                && (o["props"]["metadata.name"].as_str() == Some(name)
                    || props(o)["metadata.name"].as_str() == Some(name))
        })
        .flat_map(|o| o["metadata"].as_array().cloned().unwrap_or_default())
        .filter_map(|e| {
            let value = match &e["value"] {
                Value::String(s) => s.clone(),
                Value::Null => return None,
                other => other.to_string(),
            };
            Some(Entry {
                subject: as_u32(&e["subject"])?,
                key: e["key"].as_str()?.to_string(),
                value,
                kind: e["type"].as_str().unwrap_or_default().to_string(),
            })
        })
        .collect()
}

/// The id of the node named `name`, if it exists.
pub fn node_named(dump: &Value, name: &str) -> Option<u32> {
    dump.as_array()?
        .iter()
        .find(|o| kind(o) == "Node" && props(o)["node.name"].as_str() == Some(name))
        .and_then(|o| as_u32(&o["id"]))
}

/// The park sinks that exist (any owner).
#[cfg(test)]
pub fn park_sinks(dump: &Value) -> Vec<(u32, String)> {
    let Some(objects) = dump.as_array() else { return Vec::new() };
    objects
        .iter()
        .filter(|o| kind(o) == "Node")
        .filter_map(|o| {
            let name = props(o)["node.name"].as_str()?;
            name.starts_with(PARK_PREFIX).then(|| Some((as_u32(&o["id"])?, name.to_string())))?
        })
        .collect()
}

/// Whether `node` is linked to `sink` and to nothing else.
pub fn linked_only_to(dump: &Value, node: u32, sink: u32) -> bool {
    let Some(objects) = dump.as_array() else { return false };
    let targets: Vec<u32> = objects
        .iter()
        .filter(|o| kind(o) == "Link")
        .filter(|o| as_u32(&o["info"]["output-node-id"]) == Some(node))
        .filter_map(|o| as_u32(&o["info"]["input-node-id"]))
        .collect();
    !targets.is_empty() && targets.iter().all(|t| *t == sink)
}

/// What to save for `node` before moving it: its current routing entries, as JSON
/// (`{"target.object": {"value": "…", "type": "…"}}`, `{}` when it had none).
pub fn saved_routing(entries: &[Entry], node: u32) -> String {
    let mut saved = serde_json::Map::new();
    for e in entries.iter().filter(|e| e.subject == node && TARGET_KEYS.contains(&e.key.as_str())) {
        saved.insert(e.key.clone(), serde_json::json!({ "value": e.value, "type": e.kind }));
    }
    Value::Object(saved).to_string()
}

/// The changes that move `node` to the sink named `sink`, saving what was there.
pub fn park_changes(entries: &[Entry], node: u32, sink: &str) -> Vec<Change> {
    let mut out = vec![Change {
        subject: node,
        key: RESTORE_KEY.into(),
        set: Some((saved_routing(entries, node), "Spa:String:JSON".into())),
    }];
    // The legacy key would compete with the new target.
    if entries.iter().any(|e| e.subject == node && e.key == "target.node") {
        out.push(Change { subject: node, key: "target.node".into(), set: None });
    }
    out.push(Change { subject: node, key: "target.object".into(), set: Some((sink.into(), "Spa:String".into())) });
    out
}

/// The changes that put every parked stream back (whoever parked it): its saved routing entries
/// restored, the others removed, and the saved copy removed.
pub fn restore_changes(entries: &[Entry]) -> Vec<Change> {
    let mut out = Vec::new();
    for e in entries.iter().filter(|e| e.key == RESTORE_KEY) {
        let saved: serde_json::Map<String, Value> =
            serde_json::from_str::<Value>(&e.value).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default();
        for key in TARGET_KEYS {
            let set = saved.get(*key).and_then(|v| {
                Some((v["value"].as_str()?.to_string(), v["type"].as_str().unwrap_or_default().to_string()))
            });
            let present = entries.iter().any(|x| x.subject == e.subject && x.key == *key);
            if set.is_some() || present {
                out.push(Change { subject: e.subject, key: (*key).into(), set });
            }
        }
        out.push(Change { subject: e.subject, key: RESTORE_KEY.into(), set: None });
    }
    out
}

// ---- running the tools ----

fn on_path(tool: &str) -> bool {
    std::env::var_os("PATH").is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(tool).is_file()))
}

/// Whether the tools are here; says so once when not.
fn available(steps: &mut Steps) -> bool {
    let missing: Vec<&str> = ["pw-dump", "pw-cli", "pw-metadata"].into_iter().filter(|t| !on_path(t)).collect();
    if missing.is_empty() {
        return true;
    }
    if !SAID_UNAVAILABLE.swap(true, Ordering::Relaxed) {
        let line = format!(
            "audio: {} not found; other apps' sound may stop while a native PipeWire game is paused",
            missing.join(", ")
        );
        eprintln!("game pause: {line}");
        steps.push(line);
    }
    false
}

/// Runs `command` with a time limit; its stdout when it succeeded.
fn run(mut command: Command) -> Result<String, String> {
    let what = format!("{:?}", command.get_program());
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("{what}: {e}"))?;
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + COMMAND_LIMIT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let text = reader.join().unwrap_or_default();
                return if status.success() { Ok(text) } else { Err(format!("{what} exited with {status}")) };
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("{what} took longer than {} s", COMMAND_LIMIT.as_secs()));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) => return Err(format!("{what}: {e}")),
        }
    }
}

/// A PipeWire tool from the host, without the AppImage runtime's library path: with it, the
/// host's `pw-*` tools load the bundled libpipewire, which cannot find the host's SPA plugins
/// ("can't make support.system handle"), so nothing could be parked or put back.
fn host(program: &str) -> Command {
    let mut command = Command::new(program);
    command.env_remove("LD_LIBRARY_PATH").env_remove("LD_PRELOAD");
    command
}

fn dump() -> Result<Value, String> {
    let text = run(host("pw-dump"))?;
    serde_json::from_str(&text).map_err(|e| format!("pw-dump: {e}"))
}

fn apply(change: &Change) -> Result<(), String> {
    let mut command = host("pw-metadata");
    command.args(["-n", "default"]);
    match &change.set {
        Some((value, kind)) => {
            command.arg(change.subject.to_string()).arg(&change.key).arg(value);
            if !kind.is_empty() {
                command.arg(kind);
            }
        }
        None => {
            command.arg("-d").arg(change.subject.to_string()).arg(&change.key);
        }
    }
    run(command).map(|_| ())
}

fn describe(change: &Change) -> String {
    match &change.set {
        Some((value, _)) => format!("node {} {} = {value}", change.subject, change.key),
        None => format!("node {} {} removed", change.subject, change.key),
    }
}

/// A park sink, alive as long as this value (its `pw-cli` owner).
pub struct Parked {
    owner: Child,
    pub sink: String,
    pub streams: Vec<Stream>,
}

impl Parked {
    #[cfg(test)]
    pub fn owner_pid(&self) -> u32 {
        self.owner.id()
    }
}

impl Drop for Parked {
    fn drop(&mut self) {
        let _ = self.owner.kill();
        let _ = self.owner.wait();
    }
}

/// Starts the `pw-cli` that owns the park sink `name`; it dies with this process.
fn spawn_owner(name: &str) -> Result<Child, String> {
    use std::io::Write;
    use std::os::unix::process::CommandExt;
    let mut command = host("pw-cli");
    command.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null());
    unsafe {
        command.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn().map_err(|e| format!("pw-cli: {e}"))?;
    let line = format!(
        "create-node adapter {{ factory.name=support.null-audio-sink node.name={name} \
         node.description=\"Kimochi (game paused)\" media.class=Audio/Sink object.linger=false \
         audio.position=[FL FR] node.virtual=true node.always-process=true priority.session=0 priority.driver=0 }}\n"
    );
    // The pipe stays open (pw-cli does not end on end of input; it is killed instead).
    let written = child.stdin.as_mut().ok_or("pw-cli: no stdin".to_string()).and_then(|stdin| {
        stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(|e| format!("pw-cli: {e}"))
    });
    if let Err(e) = written {
        let _ = child.kill();
        let _ = child.wait();
        return Err(e);
    }
    Ok(child)
}

/// Polls `pw-dump` until `done` says so or [`SETTLE`] passes.
fn settle<T>(mut done: impl FnMut(&Value) -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + SETTLE;
    loop {
        if let Ok(dump) = dump() {
            if let Some(value) = done(&dump) {
                return Some(value);
            }
        }
        if Instant::now() >= deadline {
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Moves the native PipeWire playback streams of `pids` to a park sink. `None` when there are none
/// or it could not be done (said in `steps`); the pause goes ahead either way.
pub fn park(pids: &[u32], steps: &mut Steps) -> Option<Parked> {
    let started = Instant::now();
    if !available(steps) {
        return None;
    }
    let first = match dump() {
        Ok(dump) => dump,
        Err(e) => {
            steps.push(format!("audio: cannot read the PipeWire graph ({e}); not parked"));
            return None;
        }
    };
    let streams = game_streams(&first, pids);
    if streams.is_empty() {
        steps.push("audio: no native PipeWire streams in the game; nothing to park".into());
        return None;
    }
    let sink = format!("{PARK_PREFIX}-{}", std::process::id());
    let owner = match spawn_owner(&sink) {
        Ok(owner) => owner,
        Err(e) => {
            steps.push(format!("audio: could not create the park sink ({e}); not parked"));
            return None;
        }
    };
    let mut parked = Parked { owner, sink: sink.clone(), streams: Vec::new() };
    let Some(sink_id) = settle(|d| node_named(d, &sink)) else {
        steps.push(format!("audio: park sink {sink} did not appear; not parked"));
        return None;
    };
    steps.push(format!("audio: park sink {sink} is node {sink_id}"));
    let entries = metadata(&first, "default");
    for stream in streams {
        let changes = park_changes(&entries, stream.node, &sink);
        let mut ok = true;
        for change in &changes {
            if let Err(e) = apply(change) {
                steps.push(format!("audio: {} failed: {e}", describe(change)));
                ok = false;
                break;
            }
        }
        steps.push(format!(
            "audio: stream node {} ({}, pid {}) {} (saved {})",
            stream.node,
            stream.name,
            stream.pid,
            if ok { "moved to the park sink" } else { "not moved" },
            saved_routing(&entries, stream.node)
        ));
        parked.streams.push(stream);
    }
    let nodes: Vec<u32> = parked.streams.iter().map(|s| s.node).collect();
    match settle(|d| nodes.iter().all(|n| linked_only_to(d, *n, sink_id)).then_some(())) {
        Some(()) => {
            steps.push(format!("audio: parked {} stream(s) in {} ms", nodes.len(), started.elapsed().as_millis()))
        }
        None => steps.push(format!(
            "audio: streams not linked to the park sink after {} ms; other apps may go quiet during the pause",
            started.elapsed().as_millis()
        )),
    }
    Some(parked)
}

/// Puts back every parked stream (whoever parked it) and removes `parked`'s sink. Safe to call
/// when nothing was parked: it then only looks.
pub fn unpark(parked: Option<Parked>, steps: &mut Steps) {
    let started = Instant::now();
    if !available(steps) {
        return;
    }
    match dump() {
        Ok(dump) => {
            let changes = restore_changes(&metadata(&dump, "default"));
            for change in &changes {
                match apply(change) {
                    Ok(()) => steps.push(format!("audio: restored {}", describe(change))),
                    Err(e) => steps.push(format!("audio: restoring {} failed: {e}", describe(change))),
                }
            }
            if !changes.is_empty() {
                steps.push(format!("audio: streams put back in {} ms", started.elapsed().as_millis()));
            }
        }
        Err(e) => steps.push(format!("audio: cannot read the PipeWire graph to put streams back ({e})")),
    }
    if let Some(parked) = parked {
        let sink = parked.sink.clone();
        drop(parked);
        let gone = settle(|d| node_named(d, &sink).is_none().then_some(())).is_some();
        steps.push(format!("audio: park sink {sink} {}", if gone { "removed" } else { "still listed after 1 s" }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn graph() -> Value {
        json!([
            {"id": 30, "type": "PipeWire:Interface:Client", "info": {"props": {"pipewire.sec.pid": 500, "application.process.id": 7}}},
            {"id": 31, "type": "PipeWire:Interface:Client", "info": {"props": {"pipewire.sec.pid": 600}}},
            {"id": 32, "type": "PipeWire:Interface:Client", "info": {"props": {"pipewire.sec.pid": 2180, "application.name": "pipewire-pulse"}}},
            {"id": 40, "type": "PipeWire:Interface:Node", "info": {"props": {"client.id": 30, "media.class": "Stream/Output/Audio", "node.name": "game-music"}}},
            {"id": 41, "type": "PipeWire:Interface:Node", "info": {"props": {"client.id": 30, "media.class": "Stream/Input/Audio", "node.name": "game-mic"}}},
            {"id": 42, "type": "PipeWire:Interface:Node", "info": {"props": {"client.id": 31, "media.class": "Stream/Output/Audio", "node.name": "browser"}}},
            {"id": 43, "type": "PipeWire:Interface:Node", "info": {"props": {"client.id": 32, "media.class": "Stream/Output/Audio", "node.name": "wine-game-via-pulse"}}},
            {"id": 44, "type": "PipeWire:Interface:Node", "info": {"props": {"client.id": 30, "media.class": "Stream/Output/Audio", "node.name": "game-sfx"}}},
            {"id": 55, "type": "PipeWire:Interface:Node", "info": {"props": {"media.class": "Audio/Sink", "node.name": "alsa_output"}}},
            {"id": 90, "type": "PipeWire:Interface:Node", "info": {"props": {"media.class": "Audio/Sink", "node.name": "kimochi-pause-park-123"}}},
            {"id": 70, "type": "PipeWire:Interface:Link", "info": {"output-node-id": 40, "input-node-id": 90}},
            {"id": 71, "type": "PipeWire:Interface:Link", "info": {"output-node-id": 40, "input-node-id": 90}},
            {"id": 72, "type": "PipeWire:Interface:Link", "info": {"output-node-id": 44, "input-node-id": 55}},
            {"id": 73, "type": "PipeWire:Interface:Link", "info": {"output-node-id": 44, "input-node-id": 90}},
            {"id": 20, "type": "PipeWire:Interface:Metadata", "props": {"metadata.name": "default"}, "metadata": [
                {"subject": 0, "key": "default.audio.sink", "type": "Spa:String:JSON", "value": {"name": "alsa_output"}},
                {"subject": 44, "key": "target.object", "type": "Spa:Id", "value": "55"},
                {"subject": 44, "key": "target.node", "type": "", "value": "55"},
                {"subject": 42, "key": "target.object", "type": "Spa:String", "value": "alsa_output"}
            ]},
            {"id": 21, "type": "PipeWire:Interface:Metadata", "props": {"metadata.name": "settings"}, "metadata": [
                {"subject": 44, "key": "target.object", "type": "", "value": "nope"}
            ]}
        ])
    }

    #[test]
    fn the_game_s_own_playback_streams_are_found_by_its_pids() {
        let streams = game_streams(&graph(), &[500, 501]);
        assert_eq!(streams.iter().map(|s| s.node).collect::<Vec<_>>(), vec![40, 44]);
        assert!(streams.iter().all(|s| s.pid == 500));
        // A game that plays through pipewire-pulse has no stream of its own; nobody else's is taken.
        assert!(game_streams(&graph(), &[7]).is_empty(), "the client-declared pid is not trusted over the socket's");
        assert!(game_streams(&graph(), &[999]).is_empty());
        assert!(game_streams(&json!({"not": "a list"}), &[500]).is_empty());
    }

    #[test]
    fn metadata_links_and_sinks_are_read() {
        let entries = metadata(&graph(), "default");
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0].value, r#"{"name":"alsa_output"}"#);
        assert_eq!(node_named(&graph(), "kimochi-pause-park-123"), Some(90));
        assert_eq!(park_sinks(&graph()), vec![(90, "kimochi-pause-park-123".to_string())]);
        assert!(linked_only_to(&graph(), 40, 90));
        assert!(!linked_only_to(&graph(), 44, 90), "still linked to the real sink too");
        assert!(!linked_only_to(&graph(), 42, 90));
    }

    #[test]
    fn parking_saves_the_routing_and_restoring_puts_exactly_it_back() {
        let before = metadata(&graph(), "default");
        // A stream with no routing of its own.
        let changes = park_changes(&before, 40, "kimochi-pause-park-123");
        assert_eq!(
            changes,
            vec![
                Change { subject: 40, key: RESTORE_KEY.into(), set: Some(("{}".into(), "Spa:String:JSON".into())) },
                Change {
                    subject: 40,
                    key: "target.object".into(),
                    set: Some(("kimochi-pause-park-123".into(), "Spa:String".into()))
                },
            ]
        );
        // A stream routed by both keys.
        let changes = park_changes(&before, 44, "kimochi-pause-park-123");
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[1], Change { subject: 44, key: "target.node".into(), set: None });

        // Simulate the metadata after both parks, then restore.
        let mut after: Vec<Entry> = before.iter().filter(|e| e.subject != 40 && e.subject != 44).cloned().collect();
        for (node, saved) in [(40, saved_routing(&before, 40)), (44, saved_routing(&before, 44))] {
            after.push(Entry { subject: node, key: RESTORE_KEY.into(), value: saved, kind: "Spa:String:JSON".into() });
            after.push(Entry {
                subject: node,
                key: "target.object".into(),
                value: "kimochi-pause-park-123".into(),
                kind: "Spa:String".into(),
            });
        }
        let restore = restore_changes(&after);
        assert_eq!(
            restore,
            vec![
                Change { subject: 40, key: "target.object".into(), set: None },
                Change { subject: 40, key: RESTORE_KEY.into(), set: None },
                Change { subject: 44, key: "target.object".into(), set: Some(("55".into(), "Spa:Id".into())) },
                Change { subject: 44, key: "target.node".into(), set: Some(("55".into(), "".into())) },
                Change { subject: 44, key: RESTORE_KEY.into(), set: None },
            ]
        );
        // Nothing parked: nothing to do; the browser's own routing is never touched.
        assert!(restore_changes(&before).is_empty());
    }

    #[test]
    fn a_damaged_saved_copy_still_unparks() {
        let entries = vec![
            Entry { subject: 40, key: RESTORE_KEY.into(), value: "not json".into(), kind: String::new() },
            Entry {
                subject: 40,
                key: "target.object".into(),
                value: "kimochi-pause-park-1".into(),
                kind: String::new(),
            },
        ];
        assert_eq!(
            restore_changes(&entries),
            vec![
                Change { subject: 40, key: "target.object".into(), set: None },
                Change { subject: 40, key: RESTORE_KEY.into(), set: None },
            ]
        );
    }
}

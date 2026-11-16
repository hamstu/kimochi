//! Shared Mutter-compatible ScreenCast transport for GNOME and Niri.
use super::Target;
use crate::{CaptureError, Result};
use std::{collections::HashMap, time::Duration};
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{OwnedObjectPath, Value};

pub(super) const SCREENCAST: &str = "org.gnome.Mutter.ScreenCast";
pub(super) const SCREENCAST_PATH: &str = "/org/gnome/Mutter/ScreenCast";
const STREAM_WAIT: Duration = Duration::from_secs(3);
const CURSOR_HIDDEN: u32 = 0;
fn native(e: impl ToString) -> CaptureError {
    CaptureError::new("native", e)
}

/// Start a ScreenCast session recording one window or monitor, and its PipeWire node.
pub(super) fn record(connection: &Connection, target: Target<'_>) -> Result<(u32, Session)> {
    let screencast = Proxy::new(connection, SCREENCAST, SCREENCAST_PATH, SCREENCAST).map_err(native)?;
    let path: OwnedObjectPath = screencast
        .call("CreateSession", &(HashMap::<&str, Value>::new(),))
        .map_err(|e| native(format!("Mutter ScreenCast: {e}")))?;
    // From here the session is ours to stop, also on failure.
    let session = Session { connection: connection.clone(), path };
    let session_path = session.path.to_string();
    let proxy =
        Proxy::new(connection, SCREENCAST, session_path, "org.gnome.Mutter.ScreenCast.Session").map_err(native)?;
    let stream: OwnedObjectPath = match target {
        Target::Window(w) => {
            let id: u64 = w
                .handle
                .parse()
                .map_err(|_| CaptureError::new("stale_source", "Not a numeric compositor window id"))?;
            let mut props: HashMap<&str, Value> = HashMap::new();
            props.insert("window-id", Value::U64(id));
            props.insert("cursor-mode", Value::U32(CURSOR_HIDDEN));
            proxy.call("RecordWindow", &(props,))
        }
        Target::Output(o) => {
            let mut props: HashMap<&str, Value> = HashMap::new();
            props.insert("cursor-mode", Value::U32(CURSOR_HIDDEN));
            proxy.call("RecordMonitor", &(o.handle.as_str(), props))
        }
    }
    .map_err(|e| match target {
        Target::Window(_) => CaptureError::new("stale_source", format!("Mutter could not record that window: {e}")),
        Target::Output(_) => native(format!("Mutter could not record that monitor: {e}")),
    })?;
    drop(proxy);
    let node = async_io::block_on(started_node(connection.inner(), &session.path, &stream))?;
    Ok((node, session))
}

/// Subscribe to the stream's node announcement, start the session, and wait for the node.
async fn started_node(
    connection: &zbus::Connection,
    session: &OwnedObjectPath,
    stream: &OwnedObjectPath,
) -> Result<u32> {
    use futures_util::future::{select, Either};
    use futures_util::StreamExt;
    let stream_proxy = zbus::Proxy::new(connection, SCREENCAST, stream.as_str(), "org.gnome.Mutter.ScreenCast.Stream")
        .await
        .map_err(native)?;
    let mut added = stream_proxy.receive_signal("PipeWireStreamAdded").await.map_err(native)?;
    let session_proxy =
        zbus::Proxy::new(connection, SCREENCAST, session.as_str(), "org.gnome.Mutter.ScreenCast.Session")
            .await
            .map_err(native)?;
    session_proxy.call_method("Start", &()).await.map_err(|e| native(format!("Mutter ScreenCast Start: {e}")))?;
    let timeout = async_io::Timer::after(STREAM_WAIT);
    match select(added.next(), timeout).await {
        Either::Left((Some(message), _)) => message.body().deserialize::<u32>().map_err(native),
        Either::Left((None, _)) => Err(native("Mutter ended the stream before it started")),
        Either::Right(_) => Err(native("Mutter did not start the stream in time")),
    }
}

/// A running ScreenCast session; dropping it stops the session.
pub(super) struct Session {
    connection: Connection,
    path: OwnedObjectPath,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(proxy) =
            Proxy::new(&self.connection, SCREENCAST, self.path.as_str(), "org.gnome.Mutter.ScreenCast.Session")
        {
            // Already gone when the window closed or Mutter ended it: nothing to do.
            let _ = proxy.call_method("Stop", &());
        }
    }
}

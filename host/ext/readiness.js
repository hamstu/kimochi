/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS host adapter. */
/** Read-only adapters for the engines' own settings/status protocols. No extension edits. */
export function hachidoriReadiness(reply, installation = null) {
  const entries = installation?.entries ?? [];
  if (installation?.finished === false) {
    const active = entries.find((entry) => entry.phase === "downloading");
    const progress =
      active?.totalBytes > 0
        ? Math.min(
            100,
            Math.round((active.receivedBytes / active.totalBytes) * 100),
          )
        : null;
    return {
      phase: active ? "downloading" : "installing",
      progress,
      message: active
        ? `Hachidori is downloading dictionary data${progress === null ? "…" : `: ${progress}%`}`
        : "Hachidori is installing its dictionaries…",
    };
  }
  if (entries.some((entry) => entry.phase === "failed"))
    return {
      phase: "failed",
      message:
        "A Hachidori dictionary download failed. Open its settings to retry.",
    };
  if (!reply)
    return {
      phase: "starting",
      message: "Waiting for Hachidori’s dictionary engine…",
    };
  if (reply.ok === false)
    return {
      phase: "failed",
      message:
        reply.error ||
        "Hachidori could not load its dictionaries. Open its settings to retry.",
    };
  if (reply.loading || reply.updating)
    return {
      phase: "installing",
      message:
        "Hachidori is loading or importing dictionaries. Setup continues in the background.",
    };
  if (!reply.ready)
    return {
      phase: "starting",
      message: "Starting Hachidori’s dictionary engine…",
    };
  if (reply.failedDictionaries?.length)
    return {
      phase: "failed",
      message:
        "Some Hachidori dictionaries could not load. Open Hachidori settings to review them.",
    };
  if (!(reply.dictionaryCount > 0))
    return {
      phase: "setup-needed",
      message: "Open Hachidori settings to install or import a dictionary.",
    };
  return { phase: "ready", message: "Hachidori is ready." };
}

/** Whether a readiness status allows lookups: its `lookups` when it says, else only when ready. */
export function canLookUp(status) {
  return typeof status?.lookups === "boolean" ? status.lookups : status?.phase === "ready";
}

/**
 * 10ten's setup, as a phase for the setup screens, and whether it can look words up now
 * (`lookups`). It always can: 10ten ships a word dictionary in the extension (data/words.ljson,
 * its "flat file") and reads that while the full one downloads, fails or updates, so only the
 * setup screens wait for the download. Hachidori looks up only when ready.
 */
export function tentenReadiness(state) {
  return { ...tentenPhase(state), lookups: true };
}

function tentenPhase(state) {
  const series = ["words", "kanji", "radicals", "names"];
  const complete = series.every((name) => state?.[name]?.state === "ok");
  if (complete && state?.updateState?.type === "idle")
    return { phase: "ready", message: "10ten is ready." };
  if (state?.updateError)
    return {
      phase: "failed",
      message:
        "10ten’s dictionary download failed. Open 10ten settings to retry.",
    };
  const update = state?.updateState;
  const progress =
    typeof update?.totalProgress === "number"
      ? Math.max(0, Math.min(100, Math.round(update.totalProgress * 100)))
      : null;
  if (update?.type === "updating" || update?.type === "checking")
    return {
      phase: "downloading",
      progress,
      message: `10ten is ${update.type === "checking" ? "checking" : "downloading"} ${update.series || "dictionary"} data${progress === null ? "…" : `: ${progress}%`}`,
    };
  return {
    phase: "setup-needed",
    message:
      "10ten needs its dictionary data. Open 10ten settings to start or retry the download.",
  };
}

/** One observer per hub; a normal content context uses the same APIs as the settings pages. */
export function watchReadiness({
  win,
  engine,
  chrome,
  publish,
  subscribe = () => {},
}) {
  let stopped = false;
  let timer = null;
  let port = null;
  let last = "";
  let engineStatus = null;
  let installation = null;
  const send = (status) => {
    if (stopped || JSON.stringify(status) === last) return;
    last = JSON.stringify(status);
    publish(status);
  };
  const schedule = (job, delay = 2000) => {
    if (!stopped) timer = win.setTimeout(job, delay);
  };
  const poll = async () => {
    let delay = 2000;
    try {
      const reply = await chrome.runtime.sendMessage({
        target: "hoshidicts-offscreen",
        type: "hd_status",
        requestId: `kimochi-status-${Date.now()}`,
      });
      engineStatus = reply;
      const status = hachidoriReadiness(reply, installation);
      send(status);
      // Loading an installed engine is brief. Do not hide its completion behind
      // the idle poll interval; actual download progress comes through setup events.
      if (!installation && (status.phase === "starting" || status.phase === "installing")) delay = 250;
    } catch {
      send({
        phase: "starting",
        message:
          "Waiting for Hachidori’s dictionary engine. Its settings remain available.",
      });
    }
    schedule(poll, delay);
  };
  const connect = () => {
    try {
      port = chrome.runtime.connect({ name: "options" });
      port.onMessage.addListener((event) => {
        if (event?.type === "dbstateupdated")
          send(tentenReadiness(event.state));
      });
      port.onDisconnect.addListener(() => {
        send({ phase: "starting", message: "Reconnecting to 10ten’s dictionary engine…" });
        schedule(connect);
      });
    } catch {
      schedule(connect);
    }
  };
  send({
    phase: "starting",
    message: `Preparing ${engine === "tenten" ? "10ten" : "Hachidori"} dictionary data…`,
  });
  subscribe((message) => {
    if (
      engine !== "hachidori" ||
      message?.target !== "hachidori-setup-events" ||
      message.type !== "hd_setup_progress"
    )
      return;
    if (
      installation?.runId === message.runId &&
      installation.sequence >= message.sequence
    )
      return;
    installation = message;
    send(hachidoriReadiness(engineStatus, installation));
  });
  if (engine === "tenten") connect();
  else void poll();
  const stop = () => {
    stopped = true;
    win.clearTimeout(timer);
    port?.disconnect();
  };
  win.addEventListener("pagehide", stop, { once: true });
  return stop;
}

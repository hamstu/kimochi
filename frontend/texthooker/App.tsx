/** Super Texthooker transcript inside Kimochi's native PanelShell. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Minus, Plus, Settings as SettingsIcon } from "lucide-react";
import { LineRow } from "./components/LineRow";
import { SessionBar } from "./components/SessionBar";
import { ExplainModal } from "./components/ExplainModal";
import { SelectionAddButton } from "./components/SelectionAddButton";
import { AddToNotebookModal } from "./components/AddToNotebookModal";
import { StatsFooter } from "./components/StatsFooter";
import { onEditModalRequest } from "./lib/editModal";
import { getSettings, onSettingsChange, updateSettings } from "./lib/settings";
import { getSnapshot, subscribe } from "./bridge";
import { startHost } from "./host";
import { useClipboardPoll } from "./hooks/useClipboardPoll";
import { useWebSocketInput } from "./hooks/useWebSocketInput";
import type { SocketStatus } from "./websocket-input";
import { useScanMode } from "./hooks/useScanMode";
import { useLineHotkeys } from "./hooks/useLineHotkeys";
import { usePanelYomitan } from "../shell/panelYomitan";
import { panel } from "../bridge/tauri";
import { setSetting } from "../bridge/settings";

async function openReaderSettings(): Promise<void> {
  await setSetting("settingsActiveTab", "texthooker");
  await panel("settings", "show");
}
async function openNotebook(entryId?: string): Promise<void> {
  if (entryId)
    await setSetting("notebookEditRequest", {
      entryId,
      sessionId: getSnapshot().sessions.activeId,
      requestId: crypto.randomUUID(),
    });
  await panel("notebook", "show");
}
export default function ReaderApp() {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const fail = (event: PromiseRejectionEvent) =>
      setError(String(event.reason));
    window.addEventListener("unhandledrejection", fail);
    return () => window.removeEventListener("unhandledrejection", fail);
  }, []);

  useEffect(() => {
    let active = true;
    void startHost()
      .then(() => {
        if (active) setReady(true);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, []);
  if (!ready)
    return (
      <div role="status" className="p-4">
        {error || "Loading Texthooker…"}
      </div>
    );
  return <Transcript />;
}
function Transcript() {
  const [snap, setSnap] = useState(getSnapshot);
  const [settings, setSettings] = useState(getSettings);
  const [error, setError] = useState("");
  useEffect(() => {
    const fail = (event: PromiseRejectionEvent) =>
      setError(String(event.reason));
    window.addEventListener("unhandledrejection", fail);
    return () => window.removeEventListener("unhandledrejection", fail);
  }, []);

  const [addText, setAddText] = useState<string | null>(null);
  const [shown, setShown] = useState(100);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const apiMode = settings.dictionaryMode === "custom-api";
  const lookup = usePanelYomitan(!apiMode);
  useEffect(() => subscribe(setSnap), []);
  useEffect(() => onSettingsChange(setSettings), []);
  useEffect(
    () =>
      onEditModalRequest((entryId) => {
        void openNotebook(entryId).catch((e) => setError(String(e)));
      }),
    [],
  );
  useEffect(() => {
    const listeners = [
      listen<{ message: string }>("reader:error", (e) =>
        setError(e.payload.message),
      ),
      listen<{ entryId: string }>("notebook:edit-request", (e) => {
        void invoke("hide_popover");
        void openNotebook(e.payload.entryId).catch((error) =>
          setError(String(error)),
        );
      }),
    ];
    return () => {
      for (const pending of listeners) void pending.then((stop) => stop());
    };
  }, []);
  const [inputStatus, setInputStatus] = useState<SocketStatus | null>(null);
  const socketStatus = useCallback(
    (status: SocketStatus | null) => setInputStatus(status),
    [],
  );
  useClipboardPoll();
  useWebSocketInput(socketStatus);
  useScanMode(apiMode);
  useLineHotkeys();
  useLayoutEffect(() => {
    if (follow.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [snap.lines.length, snap.sessions.activeId]);
  const changeFont = (delta: number) =>
    void updateSettings({
      fontSizePx: Math.max(12, Math.min(48, settings.fontSizePx + delta)),
    });
  return (
    <div className="texthooker app-root flex h-full min-h-0 flex-col">
      <SessionBar
        onOpenNotebook={() =>
          void openNotebook().catch((e) => setError(String(e)))
        }
      />
      {inputStatus && (
        <div
          role="status"
          className="px-3 py-1 text-xs text-(--color-text-muted)"
        >
          {inputStatus.message}
        </div>
      )}
      {error && (
        <div role="alert" className="reader-error">
          {error}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {!apiMode && lookup.status === "unavailable" && (
        <div role="status" className="reader-error">
          Dictionary: {lookup.message}
        </div>
      )}
      <main
        ref={scroll}
        onScroll={() => {
          const e = scroll.current;
          if (e)
            follow.current = e.scrollHeight - e.scrollTop - e.clientHeight < 32;
        }}
        className="relative flex-1 min-h-0 overflow-y-auto px-4 py-3"
      >
        {!snap.lines.length && (
          <p className="text-xs text-(--color-text-muted)">
            Choose OCR, Clipboard or WebSocket in Texthooker settings to start
            reading.
          </p>
        )}
        {snap.lines.length > shown && (
          <button
            onClick={() => setShown((n) => n + 100)}
            className="text-xs mb-3"
          >
            Show earlier lines
          </button>
        )}
        <div
          className="jp-text scan-region"
          translate="no"
          lang="ja"
          style={{ fontSize: settings.fontSizePx }}
        >
          {snap.lines.slice(-shown).map((line) => (
            <LineRow
              key={`${snap.sessions.activeId}:${line.id}`}
              line={apiMode ? line : { ...line, tokens: null }}
              yomitanBaseUrl={settings.yomitanApiUrl}
              showFurigana={settings.showFurigana}
              disableClickToDefine={!apiMode || settings.disableClickToDefine}
              translateEnabled={Boolean(settings.deeplApiKey.trim())}
            />
          ))}
        </div>
      </main>
      <footer className="flex flex-none items-center justify-between border-t border-(--color-border) px-3 py-2 text-xs">
        <StatsFooter lineCount={snap.lines.length} />
        <div className="flex gap-2">
          <button title="Smaller text" onClick={() => changeFont(-1)}>
            <Minus size={14} />
          </button>
          <button title="Larger text" onClick={() => changeFont(1)}>
            <Plus size={14} />
          </button>
          <button
            title="Texthooker settings"
            onClick={() => void openReaderSettings()}
          >
            <SettingsIcon size={14} />
          </button>
        </div>
      </footer>
      <SelectionAddButton containerRef={scroll} enabled onAdd={setAddText} />
      <AddToNotebookModal text={addText} onClose={() => setAddText(null)} />
      <ExplainModal />
    </div>
  );
}

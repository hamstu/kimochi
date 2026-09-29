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
import {
  AArrowDown,
  AArrowUp,
  ChevronUp,
  ScrollText,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  Bar,
  BarSpacer,
  Button,
  Callout,
  EmptyState,
  IconButton,
  Spinner,
  StatusDot,
  Tooltip,
  type Tone,
} from "@kit";
import "./log.css";
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
    return error ? (
      <div className="log-loading-error">
        <Callout tone="danger">{error}</Callout>
      </div>
    ) : (
      <div role="status" className="log-loading">
        <Spinner label="Loading" />
        Loading Texthooker…
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
  const statusTone: Record<SocketStatus["state"], Tone> = {
    connected: "ok",
    connecting: "warn",
    retrying: "warn",
    invalid: "danger",
  };
  return (
    <div className="texthooker app-root log-root">
      <SessionBar
        onOpenNotebook={() =>
          void openNotebook().catch((e) => setError(String(e)))
        }
      />
      {inputStatus && (
        <div role="status" className="log-status">
          <StatusDot tone={statusTone[inputStatus.state]} />
          <span>{inputStatus.message}</span>
        </div>
      )}
      {(error || (!apiMode && lookup.status === "unavailable")) && (
        <div className="log-callouts">
          {error && (
            <Callout tone="danger">
              <span className="log-callout-row">
                <span>{error}</span>
                <Button variant="ghost" size="sm" onClick={() => setError("")}>
                  Dismiss
                </Button>
              </span>
            </Callout>
          )}
          {!apiMode && lookup.status === "unavailable" && (
            <Callout tone="warn">Dictionary: {lookup.message}</Callout>
          )}
        </div>
      )}
      <main
        ref={scroll}
        onScroll={() => {
          const e = scroll.current;
          if (e)
            follow.current = e.scrollHeight - e.scrollTop - e.clientHeight < 32;
        }}
        className="log-transcript"
      >
        {!snap.lines.length && (
          <EmptyState
            className="log-empty"
            icon={<ScrollText />}
            title="No lines yet"
            actions={
              <Button size="sm" onClick={() => void openReaderSettings()}>
                <SettingsIcon />
                Texthooker settings
              </Button>
            }
          >
            Choose OCR, Clipboard or WebSocket in Texthooker settings to start
            reading.
          </EmptyState>
        )}
        {snap.lines.length > shown && (
          <div className="log-earlier">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShown((n) => n + 100)}
            >
              <ChevronUp />
              Show earlier lines
            </Button>
          </div>
        )}
        <div
          className="jp-text scan-region log-lines"
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
      <Bar position="bottom">
        <StatsFooter lineCount={snap.lines.length} />
        <BarSpacer />
        <div className="log-bar-actions">
          <Tooltip content="Smaller text">
            <IconButton
              label="Smaller text"
              size="sm"
              disabled={settings.fontSizePx <= 12}
              onClick={() => changeFont(-1)}
            >
              <AArrowDown />
            </IconButton>
          </Tooltip>
          <Tooltip content="Larger text">
            <IconButton
              label="Larger text"
              size="sm"
              disabled={settings.fontSizePx >= 48}
              onClick={() => changeFont(1)}
            >
              <AArrowUp />
            </IconButton>
          </Tooltip>
          <span className="log-bar-divider" aria-hidden />
          <Tooltip content="Texthooker settings">
            <IconButton
              label="Texthooker settings"
              size="sm"
              onClick={() => void openReaderSettings()}
            >
              <SettingsIcon />
            </IconButton>
          </Tooltip>
        </div>
      </Bar>
      <SelectionAddButton containerRef={scroll} enabled onAdd={setAddText} />
      <AddToNotebookModal text={addText} onClose={() => setAddText(null)} />
      <ExplainModal />
    </div>
  );
}

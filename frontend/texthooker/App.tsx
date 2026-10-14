/**
 * The Log: Super Texthooker's transcript, and the host gate that starts its session owner. The
 * main window (`frontend/main/MainPanel.tsx`) composes these with its sidebar and the Notebook.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AArrowDown, AArrowUp, ChevronUp, ScrollText } from "lucide-react";
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
import { ExplainModal } from "./components/ExplainModal";
import { SelectionAddButton } from "./components/SelectionAddButton";
import { AddToNotebookModal } from "./components/AddToNotebookModal";
import { StatsFooter } from "./components/StatsFooter";
import { LogMoreMenu } from "./components/LogMoreMenu";
import { SessionMenu } from "../main/SessionMenu";
import { ActivityTicker } from "./components/ActivityTicker";
import { useActivity } from "../bridge/activity";
import { onEditModalRequest } from "./lib/editModal";
import { getSettings, onSettingsChange, updateSettings } from "./lib/settings";
import { getSnapshot, subscribe } from "./bridge";
import { startHost } from "./host";
import { useClipboardPoll } from "./hooks/useClipboardPoll";
import { useWebSocketInput } from "./hooks/useWebSocketInput";
import type { SocketStatus } from "./websocket-input";
import { useScanMode } from "./hooks/useScanMode";
import { useLineHotkeys } from "./hooks/useLineHotkeys";
import { usePanelDictionary } from "../shell/panelDictionary";
import { openSettings } from "../bridge/tauri";

/** Starts the session owner, then renders its children; shows progress or the failure meanwhile. */
export function ReaderHost({ children }: { children: ReactNode }) {
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
        Loading the log…
      </div>
    );
  return children;
}

interface TranscriptProps {
  /** Shows the Notebook, with one entry open when an id is given. */
  onOpenNotebook: (entryId?: string) => void;
  /** False while another view covers the Log; its intake and lookups keep running. */
  visible: boolean;
}

export function Transcript({ onOpenNotebook, visible }: TranscriptProps) {
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
  const hasActivity = useActivity().length > 0;
  const [shown, setShown] = useState(100);
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const apiMode = settings.dictionaryMode === "custom-api";
  const lookup = usePanelDictionary(!apiMode);
  useEffect(() => subscribe(setSnap), []);
  useEffect(() => onSettingsChange(setSettings), []);
  const openNotebook = useRef(onOpenNotebook);
  useLayoutEffect(() => {
    openNotebook.current = onOpenNotebook;
  });
  useEffect(
    () => onEditModalRequest((entryId) => openNotebook.current(entryId)),
    [],
  );
  useEffect(() => {
    const listeners = [
      listen<{ message: string }>("reader:error", (e) =>
        setError(e.payload.message),
      ),
      listen<{ entryId: string }>("notebook:edit-request", (e) => {
        void invoke("hide_popover");
        openNotebook.current(e.payload.entryId);
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
    <div className="texthooker app-root log-root" hidden={!visible}>
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
      <div
        className="log-transcript-frame"
        data-activity={hasActivity || undefined}
      >
        <main
          ref={scroll}
          onScroll={() => {
            const e = scroll.current;
            if (e)
              follow.current =
                e.scrollHeight - e.scrollTop - e.clientHeight < 32;
          }}
          className="log-transcript"
        >
          {!snap.lines.length && (
            <EmptyState
              className="log-empty"
              icon={<ScrollText />}
              title="No lines yet"
              actions={
                <Button size="sm" onClick={() => void openSettings("sources")}>
                  Source settings
                </Button>
              }
            >
              Lines from your source appear here. Choose the screen, the
              clipboard or a WebSocket with the source menu in the sidebar.
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
        <ActivityTicker visible={visible} />
      </div>
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
          <SessionMenu />
          <LogMoreMenu />
        </div>
      </Bar>
      <SelectionAddButton containerRef={scroll} enabled onAdd={setAddText} />
      <AddToNotebookModal text={addText} onClose={() => setAddText(null)} />
      <ExplainModal />
    </div>
  );
}

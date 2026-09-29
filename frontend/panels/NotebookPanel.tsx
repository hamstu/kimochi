import { useEffect, useRef, useState, type JSX } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  getSetting,
  onSettingsChange as onNativeSettingChange,
} from "../bridge/settings";
import { initializeClient } from "../texthooker/bridge";
import { EditEntryModal } from "../texthooker/components/EditEntryModal";
import { NotebookPanel as NotebookContent } from "../texthooker/components/NotebookPanel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../texthooker/components/ui/select";
import { onEditModalRequest } from "../texthooker/lib/editModal";
import { getEntry } from "../texthooker/lib/notebook";
import { loadSettings } from "../texthooker/lib/settings";
import {
  getActiveSession,
  listSessions,
  subscribeSessions,
  switchSession,
} from "../texthooker/lib/sessions";
import type { SessionMeta } from "../texthooker/lib/types";

interface NotebookEditRequest {
  entryId: string;
  sessionId: string;
  requestId: string;
}

function notebookEditRequest(value: unknown): NotebookEditRequest | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Partial<NotebookEditRequest>;
  return typeof request.entryId === "string" &&
    request.entryId.length > 0 &&
    typeof request.sessionId === "string" &&
    request.sessionId.length > 0 &&
    typeof request.requestId === "string" &&
    request.requestId.length > 0
    ? (request as NotebookEditRequest)
    : null;
}

export default function NotebookPanel(): JSX.Element {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [requestError, setRequestError] = useState("");
  const [edit, setEdit] = useState<string | null>(null);
  const consumed = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    let initialized = false;
    let changedBeforeInitialization = false;
    let pending: unknown = null;
    let chain = Promise.resolve();

    const consume = (raw: unknown): void => {
      if (raw === null || raw === undefined) return;
      const request = notebookEditRequest(raw);

      chain = chain
        .catch(() => undefined)
        .then(async () => {
          if (!active) return;
          if (!request) {
            setRequestError(
              "Could not open the notebook entry: the request was invalid.",
            );
            return;
          }
          if (consumed.current.has(request.requestId)) return;
          consumed.current.add(request.requestId);

          if (getActiveSession().id !== request.sessionId) {
            setRequestError(
              "Could not open the notebook entry because its session is no longer active.",
            );
          } else if (!getEntry(request.entryId)) {
            setRequestError(
              "Could not open the notebook entry because it no longer exists.",
            );
          } else {
            setRequestError("");
            setEdit(request.entryId);
          }
          try {
            await invoke<boolean>("reader_notebook_ack", {
              requestId: request.requestId,
            });
          } catch (caught) {
            if (active) {
              setRequestError(
                `Could not clear the notebook edit request: ${String(caught)}`,
              );
            }
          }
        });
    };

    // Subscribe before reading so a request written while this lazy window is
    // initializing cannot fall between the initial read and the live listener.
    const offRequest = onNativeSettingChange((key, value) => {
      if (key !== "notebookEditRequest") return;
      if (!initialized) {
        changedBeforeInitialization = true;
        pending = value;
      } else {
        consume(value);
      }
    });

    void Promise.all([
      initializeClient(),
      loadSettings(),
      getSetting<unknown>("notebookEditRequest", null),
    ])
      .then(([, , initialRequest]) => {
        if (!active) return;
        initialized = true;
        setReady(true);
        consume(changedBeforeInitialization ? pending : initialRequest);
      })
      .catch((caught) => {
        if (active) setError(String(caught));
      });
    const offEdit = onEditModalRequest(setEdit);
    return () => {
      active = false;
      offEdit();
      offRequest();
    };
  }, []);

  if (!ready) {
    return (
      <div role="status" className="p-4 text-xs">
        {error || "Loading notebook…"}
      </div>
    );
  }

  return (
    <div className="texthooker flex h-full min-h-0 flex-col">
      <NotebookSessionSelect />
      {requestError ? (
        <div
          role="alert"
          className="mx-4 mt-3 rounded-md bg-(--color-danger)/10 px-3 py-2 text-xs text-(--color-danger)"
        >
          {requestError}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <NotebookContent />
      </div>
      <EditEntryModal entryId={edit} onClose={() => setEdit(null)} />
    </div>
  );
}

function NotebookSessionSelect(): JSX.Element {
  const [active, setActive] = useState<SessionMeta>(() => getActiveSession());
  const [sessions, setSessions] = useState<SessionMeta[]>(() => listSessions());

  useEffect(
    () =>
      subscribeSessions((manifest) => {
        const next = manifest.sessions.find(
          (session) => session.id === manifest.activeId,
        );
        if (next) setActive(next);
        setSessions(manifest.sessions.slice());
      }),
    [],
  );

  return (
    <div className="flex flex-none items-center gap-3 border-b border-(--color-border) bg-(--color-bg-elev) px-4 py-2">
      <span className="text-xs text-(--color-text-dim)">Session</span>
      <Select
        value={active.id}
        onValueChange={(id) => {
          if (id !== active.id) void switchSession(id);
        }}
      >
        <SelectTrigger className="w-full max-w-[24rem]">
          <SelectValue>{active.name}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {sessions.map((session) => (
            <SelectItem key={session.id} value={session.id}>
              {session.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

import { getActiveSession } from "./sessions";
/* Explain: run a local LLM CLI (codex or claude), or Kimochi cloud, on a line
   + its preceding context and stream the answer into the Explain modal. The
   process (or request) runs Rust-side (src-tauri/src/reader/explain.rs);
   results arrive as events. */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getSettings } from "./settings";
import { setLineExplanation, snapshotLines } from "./store";
import type { Line } from "./types";

/** How many preceding lines are included as scene context. */
const CONTEXT_LINES = 15;

export type ExplainStatus = "loading" | "streaming" | "done" | "error";

export interface ExplainState {
  line: Line;
  status: ExplainStatus;
  /** Markdown so far (full markdown when done; error message when error). */
  text: string;
  /** True when showing a previously cached explanation. */
  fromCache: boolean;
}

let state: ExplainState | null = null;
let originSession = "";
const subs = new Set<() => void>();

function notify() {
  for (const fn of subs) {
    try {
      fn();
    } catch (e) {
      console.error(e);
    }
  }
}

function setState(next: ExplainState | null) {
  state = next;
  notify();
}

export function getExplainState(): ExplainState | null {
  return state;
}

export function subscribeExplainState(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/* Request lifecycle. requestId ties streamed events to the run that asked
   for them; anything else is a stale run still flushing and is ignored. */

let requestCounter = 0;
let activeRequestId = 0;
let listenersReady: Promise<void> | null = null;

interface ExplainEvent {
  requestId: number;
  text: string;
}

function ensureListeners(): Promise<void> {
  if (listenersReady) return listenersReady;
  listenersReady = (async () => {
    await listen<ExplainEvent>("explain:chunk", (e) => {
      if (e.payload.requestId !== activeRequestId || !state) return;
      setState({
        ...state,
        status: "streaming",
        text: state.text + e.payload.text,
      });
    });
    await listen<ExplainEvent>("explain:done", (e) => {
      if (e.payload.requestId !== activeRequestId || !state) return;
      setState({ ...state, status: "done", text: e.payload.text });
      if (getActiveSession().id === originSession)
        void setLineExplanation(state.line.id, e.payload.text);
    });
    await listen<ExplainEvent>("explain:error", (e) => {
      if (e.payload.requestId !== activeRequestId || !state) return;
      setState({ ...state, status: "error", text: e.payload.text });
    });
  })();
  return listenersReady;
}

export function buildExplainPrompt(line: Line, template: string): string {
  const all = snapshotLines();
  const idx = all.findIndex((l) => l.id === line.id);
  const prev =
    idx === -1 ? [] : all.slice(Math.max(0, idx - CONTEXT_LINES), idx);
  const context = prev.length
    ? prev.map((l) => l.text).join("\n")
    : "(no previous lines available)";
  return template
    .split("{{context}}")
    .join(context)
    .split("{{sentence}}")
    .join(line.text);
}

async function runExplain(line: Line): Promise<void> {
  const settings = getSettings();
  const prompt = buildExplainPrompt(line, settings.explainPrompt);
  const provider = settings.explainProvider;
  const model =
    provider === "claude"
      ? settings.explainClaudeModel.trim()
      : provider === "codex"
        ? settings.explainCodexModel.trim()
        : "";

  const requestId = ++requestCounter;
  activeRequestId = requestId;
  setState({ line, status: "loading", text: "", fromCache: false });

  originSession = getActiveSession().id;
  await ensureListeners();
  try {
    await invoke("explain_run", {
      requestId,
      provider,
      model: model || null,
      prompt,
    });
  } catch (err) {
    if (requestId === activeRequestId && state) {
      setState({
        ...state,
        status: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Open the Explain modal for a line. Cached explanations show instantly;
    otherwise the CLI run starts immediately. */
export function openExplain(line: Line): void {
  if (line.explanation) {
    setState({ line, status: "done", text: line.explanation, fromCache: true });
    return;
  }
  void runExplain(line);
}

/** Re-run the explanation for the line currently in the modal (e.g. after
    editing the prompt or switching provider/model). */
export function regenerateExplain(): void {
  if (!state) return;
  void runExplain(state.line);
}

/** Close the modal and cancel any in-flight CLI run. */
export function closeExplain(): void {
  activeRequestId = 0;
  setState(null);
  void invoke("explain_cancel").catch(() => {});
}

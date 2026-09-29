/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
import { Check, Loader2, Plus, X as XIcon } from "lucide-react";
import {
  noteExistsForTerm,
  openInAnkiBrowser,
  resolveExpressionField,
  sendCardForTerm,
} from "@texthooker/lib/ankiconnect";
import type {
  AnkiFieldMapping,
  AnkiMediaItem,
  YomitanAnkiFields,
} from "@texthooker/lib/types";

export interface AnkiConfig {
  ankiConnectUrl: string;
  deck: string;
  model: string;
  modelFields: string[];
  mappings: AnkiFieldMapping[];
  tags: string[];
}

interface Props {
  term: string;
  fields: YomitanAnkiFields;
  audioMedia: AnkiMediaItem[];
  dictionaryMedia: AnkiMediaItem[];
  sentence: string | null;
  config: AnkiConfig;
  /** When set, the popover dispatched a "fire now" signal (e.g. Cmd+Enter). */
  triggerNonce?: number;
}

type State =
  | { kind: "checking" }
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; noteId: number }
  | { kind: "duplicate"; noteId: number }
  | { kind: "error"; message: string };

export function PopoverAddToAnki({
  term,
  fields,
  audioMedia,
  dictionaryMedia,
  sentence,
  config,
  triggerNonce,
}: Props) {
  const [state, setState] = useState<State>({ kind: "checking" });

  // On term/lookup change, check whether the card is already in the deck before
  // offering to add. While checking we show a spinner; if found we show the
  // "already in Anki" check-mark; otherwise the + button. Check failures fall
  // back to "idle" so the user can still attempt an add (which has its own
  // duplicate handling). A guard flag ignores results from a superseded term.
  useEffect(() => {
    let cancelled = false;
    setState({ kind: "checking" });
    const { name, value } = resolveExpressionField(
      config.modelFields,
      config.mappings,
      fields,
      sentence,
    );
    if (!value.trim()) {
      setState({ kind: "idle" });
      return;
    }
    void noteExistsForTerm(config.ankiConnectUrl, config.deck, name, value)
      .then((noteId) => {
        if (cancelled) return;
        setState(
          noteId !== null ? { kind: "duplicate", noteId } : { kind: "idle" },
        );
      })
      .catch(() => {
        // Anki unreachable or query failed — let the user try adding anyway.
        if (!cancelled) setState({ kind: "idle" });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, config.ankiConnectUrl, config.deck]);

  const send = async () => {
    if (state.kind === "sending" || state.kind === "checking") return;
    if (state.kind === "sent" || state.kind === "duplicate") {
      const query = `nid:${state.noteId}`;
      try {
        await openInAnkiBrowser(config.ankiConnectUrl, query);
      } catch (err) {
        setState({ kind: "error", message: String(err) });
      }
      return;
    }
    setState({ kind: "sending" });
    try {
      const r = await sendCardForTerm({
        ankiUrl: config.ankiConnectUrl,
        deck: config.deck,
        model: config.model,
        modelFields: config.modelFields,
        mappings: config.mappings,
        tags: config.tags,
        yomitan: { fields, audioMedia, dictionaryMedia },
        sentence,
      });
      setState(
        r.duplicate
          ? { kind: "duplicate", noteId: r.noteId }
          : { kind: "sent", noteId: r.noteId },
      );
    } catch (err) {
      const msg = String(err);
      const friendly = /unreachable/i.test(msg) ? "Anki not running" : msg;
      setState({ kind: "error", message: friendly });
    }
  };

  // Fire send() when triggerNonce changes (Cmd+Enter accelerator from parent).
  useEffect(() => {
    if (triggerNonce === undefined) return;
    void send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerNonce]);

  // Visuals
  let icon: React.ReactNode;
  let title: string;
  let cls = "text-(--color-text-dim) hover:text-(--color-text)";
  switch (state.kind) {
    case "checking":
      icon = <Loader2 className="h-3.5 w-3.5 animate-spin" />;
      title = "Checking Anki…";
      break;
    case "idle":
      icon = <Plus className="h-3.5 w-3.5" />;
      title = "Add to Anki";
      break;
    case "sending":
      icon = <Loader2 className="h-3.5 w-3.5 animate-spin" />;
      title = "Adding…";
      break;
    case "sent":
      icon = <Check className="h-3.5 w-3.5" />;
      title = "Added — click to open in Anki";
      cls = "text-(--color-ok)";
      break;
    case "duplicate":
      icon = <Check className="h-3.5 w-3.5" />;
      title = "Already in Anki — click to open";
      cls = "text-(--color-warn)";
      break;
    case "error":
      icon = <XIcon className="h-3.5 w-3.5" />;
      title = state.message;
      cls = "text-(--color-danger)";
      break;
  }

  return (
    <button
      type="button"
      onClick={send}
      title={title}
      disabled={state.kind === "sending" || state.kind === "checking"}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-(--color-border) bg-(--color-bg-elev) hover:bg-(--color-bg-elev-2) cursor-pointer disabled:opacity-60 ${cls}`}
    >
      {icon}
    </button>
  );
}

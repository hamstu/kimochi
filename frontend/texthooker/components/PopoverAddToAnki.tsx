/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
import { Check, CircleAlert, Plus } from "lucide-react";
import { IconButton, Spinner } from "@kit";
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
      const friendly = /unreachable|not answering/i.test(msg) ? "Anki not running" : msg;
      setState({ kind: "error", message: friendly });
    }
  };

  // Fire send() when triggerNonce changes (Cmd+Enter accelerator from parent).
  useEffect(() => {
    if (triggerNonce === undefined) return;
    void send();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerNonce]);

  // Visuals: a small icon button beside the speaker, same variant and size.
  // The tooltip (and aria-label) carries the words; the icon carries the state:
  // + to add, a spinner while Anki works, a green check once the card is in
  // Anki (click opens it there), a red alert when the last attempt failed
  // (click tries again).
  let icon: React.ReactNode;
  let label: string;
  let tone = "";
  switch (state.kind) {
    case "checking":
      icon = <Spinner label="Checking Anki" />;
      label = "Checking Anki…";
      break;
    case "idle":
      icon = <Plus />;
      label = "Add to Anki";
      break;
    case "sending":
      icon = <Spinner label="Adding to Anki" />;
      label = "Adding to Anki…";
      break;
    case "sent":
      icon = <Check />;
      label = "Added to Anki. Open in Anki";
      tone = "popover-action-ok";
      break;
    case "duplicate":
      icon = <Check />;
      label = "Already in Anki. Open in Anki";
      tone = "popover-action-ok";
      break;
    case "error":
      icon = <CircleAlert />;
      label = /[.?!]$/.test(state.message.trim())
        ? `${state.message.trim()} Click to try again.`
        : `${state.message.trim()}. Click to try again.`;
      tone = "popover-action-danger";
      break;
  }

  const busy = state.kind === "sending" || state.kind === "checking";
  // A disabled button never receives pointer events, so the busy states keep
  // the button enabled (aria-disabled) and ignore clicks in send() instead;
  // that way the tooltip still explains what it is waiting for.
  return (
    <IconButton
      size="sm"
      label={label}
      tooltipSide="left"
      onClick={() => void send()}
      aria-disabled={busy || undefined}
      className={`popover-action popover-anki ${tone}`}
    >
      {icon}
    </IconButton>
  );
}

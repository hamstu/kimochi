/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from "react";
import { Check, Plus, X as XIcon } from "lucide-react";
import { Button, Spinner, Tooltip } from "@kit";
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

  // Visuals. "Add to Anki" is the popup's one primary action; once it has run
  // (added, already in Anki, failed) the button drops to secondary with a toned
  // icon so the result reads without competing with the headword.
  let icon: React.ReactNode;
  let label: string;
  let title: string;
  let tone = "";
  switch (state.kind) {
    case "checking":
      icon = <Spinner label="Checking Anki" />;
      label = "Add to Anki";
      title = "Checking Anki…";
      break;
    case "idle":
      icon = <Plus />;
      label = "Add to Anki";
      title = "Add to Anki";
      break;
    case "sending":
      icon = <Spinner label="Adding to Anki" />;
      label = "Adding…";
      title = "Adding…";
      break;
    case "sent":
      icon = <Check />;
      label = "Added";
      title = "Added — click to open in Anki";
      tone = "popover-action-ok";
      break;
    case "duplicate":
      icon = <Check />;
      label = "In Anki";
      title = "Already in Anki — click to open";
      tone = "popover-action-warn";
      break;
    case "error":
      icon = <XIcon />;
      label = "Retry";
      title = state.message;
      tone = "popover-action-danger";
      break;
  }

  const busy = state.kind === "sending" || state.kind === "checking";
  const primary = state.kind === "idle" || busy;
  // A disabled button never receives pointer events, so the busy states keep
  // the button enabled (aria-disabled) and ignore clicks in send() instead;
  // that way the tooltip still explains what it is waiting for.
  const button = (
    <Button
      size="sm"
      variant={primary ? "primary" : "secondary"}
      aria-label={title}
      onClick={() => void send()}
      aria-disabled={busy || undefined}
      className={`popover-action popover-anki ${tone}`}
    >
      {icon}
      {label}
    </Button>
  );
  // The idle label already says what it does; other states explain themselves on hover.
  return state.kind === "idle" ? button : (
    <Tooltip content={title} side="left">
      {button}
    </Tooltip>
  );
}

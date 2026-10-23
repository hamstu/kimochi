import { invoke } from "@tauri-apps/api/core";
/* eslint react-hooks/preserve-manual-memoization: "off" -- The imported popup derives mutable display locals; this build does not enable React Compiler. */
import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ArrowLeft } from "lucide-react";
import { Button } from "@kit";
import { PopoverAudio } from "@texthooker/components/PopoverAudio";
import {
  PopoverAddToAnki,
  type AnkiConfig,
} from "@texthooker/components/PopoverAddToAnki";
import { TermDefinition } from "@texthooker/components/TermDefinition";
import { NotebookEntryCard } from "@texthooker/components/NotebookEntryCard";
import { usePopupScan, popupLevel } from "@texthooker/hooks/usePopupScan";
import { audioItemForEntry, mediaForFields } from "@texthooker/lib/audio";
import { termAllEntries } from "@texthooker/lib/yomitan";
import type {
  AnkiMediaItem,
  ResolvedTheme,
  SerializedNotebookEntry,
  YomitanAnkiFields,
} from "@texthooker/lib/types";

/**
 * A cross-reference view pushed on top of the originally-scanned term when the
 * user follows a glossary link (e.g. a redirect entry's `⟶ 取り憑く`). Each
 * frame carries its own resolved entries + media so the popover renders exactly
 * like a normal lookup, including audio. The stack lets nested links go deeper
 * and the back button unwind them. Cleared on every fresh popover:show.
 */
interface XrefFrame {
  term: string;
  state: "loading" | "loaded" | "empty" | "error";
  entries: YomitanAnkiFields[];
  audioMedia: AnkiMediaItem[];
  dictionaryMedia: AnkiMediaItem[];
}

type ShowPayload =
  | {
      kind: "loading";
      term: string;
      sentence: string | null;
    }
  | {
      kind: "loaded";
      term: string;
      /** A new word's first result; false when the same lookup's media arrives. */
      fresh: boolean;
      /** All matched entries, longest match first (Yomitan-style). */
      entries: YomitanAnkiFields[];
      audioMedia: AnkiMediaItem[];
      dictionaryMedia: AnkiMediaItem[];
      sentence: string | null;
      audioAutoplay: boolean;
      audioVolume: number;
      ankiConfig: AnkiConfig | null;
      baseUrl: string;
    }
  | {
      kind: "error";
      term: string;
      message: string;
      sentence: string | null;
    }
  | {
      kind: "notebook";
      entry: SerializedNotebookEntry;
      sentence: string | null;
    };

/** Scroll so the next (`step` 1) or previous (-1) entry sits at the top of the card. */
function jumpEntry(scroller: HTMLElement, step: number): void {
  const entries = [...scroller.querySelectorAll<HTMLElement>(".popover-entry")];
  if (!entries.length) return;
  const top = scroller.getBoundingClientRect().top;
  const offsets = entries.map(
    (entry) => entry.getBoundingClientRect().top - top + scroller.scrollTop,
  );
  let current = 0;
  offsets.forEach((offset, index) => {
    if (offset <= scroller.scrollTop + 8) current = index;
  });
  const next = Math.max(0, Math.min(entries.length - 1, current + step));
  scroller.scrollTo({ top: next === 0 ? 0 : offsets[next], behavior: "smooth" });
}

/** This window's place in the stack of pop-ups: 0 for the first. */
const level = popupLevel();

function PopoverApp() {
  const [payload, setPayload] = useState<ShowPayload | null>(null);
  const [visible, setVisible] = useState(false);
  const [ankiTriggerNonce, setAnkiTriggerNonce] = useState<number | undefined>(
    undefined,
  );
  // Stack of cross-reference lookups followed within the current popover. Empty
  // = showing the originally-scanned term. Reset whenever a new lookup arrives.
  const [xrefStack, setXrefStack] = useState<XrefFrame[]>([]);
  // Guards against a slow xref fetch landing after the user moved on (a new
  // popover:show, or popping the frame). Bumped on every navigation.
  const xrefGen = useRef(0);

  // Listen for show/hide events from the main window (via Rust).
  useEffect(() => {
    let cancelled = false;
    const unlistens: UnlistenFn[] = [];

    const registrations: Promise<unknown>[] = [];
    const register = async <T,>(
      event: string,
      handler: (e: { payload: T }) => void,
      /** Every pop-up's, rather than addressed to this window alone. */
      shared = false,
    ) => {
      const registration = shared
        ? listen<T>(event, handler)
        : getCurrentWebviewWindow().listen<T>(event, handler);
      registrations.push(registration);
      const u = await registration;
      if (cancelled) {
        u();
      } else {
        unlistens.push(u);
      }
    };

    void register<ShowPayload>("popover:show", (e) => {
      setPayload(e.payload);
      // A new lookup starts with a "loading", "error" or fresh "loaded" payload
      // (notebook payloads arrive standalone). Reset the Cmd+Enter nonce so a
      // leftover value can't auto-fire an Anki add when the new term's (keyed,
      // freshly mounted) entry buttons appear, discard any followed
      // cross-reference links so a re-hover shows the freshly-scanned term — not
      // where we drilled to — and start the new word at the top.
      if (e.payload.kind !== "loaded" || e.payload.fresh) {
        setAnkiTriggerNonce(undefined);
        xrefGen.current += 1;
        setXrefStack([]);
        document.querySelector(".popover-scroll")?.scrollTo(0, 0);
      }
      // Show window if hidden (Rust also shows it; both are idempotent).
      setVisible(true);
    });

    // Every pop-up hears every hide: this one closes when its level or one below it does.
    void register<{ level?: number } | null>(
      "popover:hide",
      (e) => {
        if ((e.payload?.level ?? 0) <= level) setVisible(false);
      },
      true,
    );

    // The overlay's controller mode: the right stick scrolls, the shoulder buttons jump from
    // one definition to the next.
    void register<{ scroll?: number; step?: number }>("popover:control", (e) => {
      if (level !== 0) return;
      const scroller = document.querySelector<HTMLElement>(".popover-scroll");
      if (!scroller) return;
      if (e.payload.scroll) scroller.scrollTop += e.payload.scroll;
      if (e.payload.step) jumpEntry(scroller, e.payload.step);
    });

    // Mirror the main window's resolved theme onto our document root.
    void register<ResolvedTheme>(
      "popover:theme",
      (e) => {
        document.documentElement.dataset.theme = e.payload;
      },
      true,
    );

    void Promise.all(registrations).then(() => invoke("reader_popup_ready"));

    return () => {
      cancelled = true;
      for (const u of unlistens) u();
    };
  }, []);

  // Esc dismisses; window blur also dismisses (handled below).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setVisible(false);
        // After the fade-out, hide the window in Rust by emitting on this side.
        // Rust listens to 'popover:dismiss' from the popover window itself.
        void invoke("hide_popover", { level });
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        setAnkiTriggerNonce((n) => (n ?? 0) + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Note: we intentionally do NOT dismiss on window blur. The popover stays
  // visible until the user explicitly hits Escape or another show_popover /
  // hide_popover command updates it. This keeps scan-mode gliding smooth.

  // When the user moves the cursor onto the card, take focus so clicks, scroll,
  // and Esc work on it. (Rust shows the window without focus by default so it
  // doesn't steal focus during scan-mode glides.) Only the card: the window's
  // transparent shadow margin around it must not take focus from the page
  // being scanned.
  const focusPopup = useCallback(() => {
    void invoke("reader_popup_focus");
  }, []);

  // Render
  let state: "loading" | "loaded" | "error" | "empty" = "loading";
  let entries: YomitanAnkiFields[] = [];
  let term = "";
  let errorMessage: string | undefined;
  let audioMedia: AnkiMediaItem[] = [];
  let dictionaryMedia: AnkiMediaItem[] = [];
  let audioAutoplay = false;
  let audioVolume = 0.9;
  let ankiConfig: AnkiConfig | null = null;
  let sentence: string | null = null;
  let notebookEntry: SerializedNotebookEntry | null = null;
  let baseUrl: string | null = null;
  // Whether the popover would normally carry media for this lookup, so a
  // followed cross-reference fetches audio/dictionary media too. Anki on or
  // autoplay on imply it; so does the base lookup having already returned audio
  // (covers audio-enabled-but-autoplay-off, where the phase-2 fetch ran).
  let baseWantsMedia = false;

  if (payload) {
    if (payload.kind === "loading") {
      term = payload.term;
      state = "loading";
      sentence = payload.sentence;
    } else if (payload.kind === "error") {
      term = payload.term;
      state = "error";
      errorMessage = payload.message;
      sentence = payload.sentence;
    } else if (payload.kind === "loaded") {
      term = payload.term;
      entries = payload.entries ?? [];
      state = entries.length > 0 ? "loaded" : "empty";
      audioMedia = payload.audioMedia;
      dictionaryMedia = payload.dictionaryMedia;
      audioAutoplay = payload.audioAutoplay;
      audioVolume = payload.audioVolume;
      ankiConfig = payload.ankiConfig;
      sentence = payload.sentence;
      baseUrl = payload.baseUrl;
      baseWantsMedia =
        payload.ankiConfig !== null ||
        payload.audioAutoplay ||
        payload.audioMedia.length > 0;
    } else if (payload.kind === "notebook") {
      notebookEntry = payload.entry;
      sentence = payload.sentence;
    }
  }

  // Follow a glossary cross-reference link: resolve the target term and push it
  // onto the stack, so the popover content becomes that word. Media is fetched
  // when the popover would normally include it (audio/Anki on) so audio and
  // add-to-Anki keep working on the drilled-to entry.
  const followCrossRef = useCallback(
    (target: string) => {
      if (!baseUrl) return;
      const gen = (xrefGen.current += 1);
      setXrefStack((prev) => [
        ...prev,
        {
          term: target,
          state: "loading",
          entries: [],
          audioMedia: [],
          dictionaryMedia: [],
        },
      ]);
      void termAllEntries(baseUrl, target, baseWantsMedia)
        .then((res) => {
          if (xrefGen.current !== gen) return; // superseded
          setXrefStack((prev) => {
            if (prev.length === 0) return prev;
            const next = prev.slice();
            next[next.length - 1] = {
              term: target,
              state: res.entries.length > 0 ? "loaded" : "empty",
              entries: res.entries,
              audioMedia: res.audioMedia,
              dictionaryMedia: res.dictionaryMedia,
            };
            return next;
          });
        })
        .catch(() => {
          if (xrefGen.current !== gen) return;
          setXrefStack((prev) => {
            if (prev.length === 0) return prev;
            const next = prev.slice();
            next[next.length - 1] = {
              ...next[next.length - 1],
              state: "error",
            };
            return next;
          });
        });
    },
    [baseUrl, baseWantsMedia],
  );

  const goBackCrossRef = useCallback(() => {
    xrefGen.current += 1; // cancel any in-flight fetch for the popped frame
    setXrefStack((prev) => prev.slice(0, -1));
  }, []);

  // A followed cross-reference overrides the base payload's entries/media while
  // it's on the stack. Re-scanning (a fresh popover:show) clears the stack.
  const activeXref =
    xrefStack.length > 0 ? xrefStack[xrefStack.length - 1] : null;
  if (activeXref) {
    term = activeXref.term;
    state = activeXref.state;
    entries = activeXref.entries;
    audioMedia = activeXref.audioMedia;
    dictionaryMedia = activeXref.dictionaryMedia;
    errorMessage = activeXref.state === "error" ? "Lookup failed." : undefined;
  }

  const isNotebook = notebookEntry !== null;

  // Shift over a word in this pop-up opens the next one on top, with this lookup's settings.
  usePopupScan(
    level,
    payload?.kind === "loaded"
      ? {
          baseUrl: payload.baseUrl,
          includeMedia: baseWantsMedia,
          audioAutoplay: payload.audioAutoplay,
          audioVolume: payload.audioVolume,
          ankiConfig: payload.ankiConfig,
        }
      : null,
  );

  return (
    <div className={`popover-shell ${visible ? "visible" : ""}`}>
      <div className="popover-card" onMouseEnter={focusPopup}>
        <div className={`popover-scroll${isNotebook ? " popover-scroll-flush" : ""}`}>
          {isNotebook && notebookEntry ? (
            <NotebookEntryCard
              entry={notebookEntry}
              onOpen={(entryId) => {
                // Hand off to the main window: it opens the edit modal (and
                // the notebook drawer) and focuses itself; we just disappear.
                void emit("notebook:edit-request", { entryId });
                setVisible(false);
                void invoke("hide_popover", { level });
              }}
            />
          ) : (
            <>
              {/* Cross-reference breadcrumb: shown once the user has followed a
                  glossary link, so they can return to the scanned term. */}
              {activeXref ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="popover-xref-back"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={goBackCrossRef}
                >
                  <ArrowLeft aria-hidden />
                  Back
                </Button>
              ) : null}
              <EntryList
                keyPrefix={`${xrefStack.length}`}
                term={term}
                state={state}
                errorMessage={errorMessage}
                entries={entries}
                audioMedia={audioMedia}
                dictionaryMedia={dictionaryMedia}
                autoplay={audioAutoplay}
                audioVolume={audioVolume}
                ankiConfig={ankiConfig}
                sentence={sentence}
                ankiTriggerNonce={activeXref ? undefined : ankiTriggerNonce}
                onCrossRef={baseUrl ? followCrossRef : undefined}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** One lookup's entries. */
function EntryList({
  keyPrefix,
  term,
  state,
  errorMessage,
  entries,
  audioMedia,
  dictionaryMedia,
  autoplay,
  audioVolume,
  ankiConfig,
  sentence,
  ankiTriggerNonce,
  onCrossRef,
}: {
  keyPrefix: string;
  term: string;
  state: "loading" | "loaded" | "error" | "empty";
  errorMessage?: string;
  entries: YomitanAnkiFields[];
  audioMedia: AnkiMediaItem[];
  dictionaryMedia: AnkiMediaItem[];
  autoplay: boolean;
  audioVolume: number;
  ankiConfig: AnkiConfig | null;
  sentence: string | null;
  ankiTriggerNonce?: number;
  onCrossRef?: (target: string) => void;
}) {
  if (state !== "loaded") {
    return <TermDefinition term={term} state={state} errorMessage={errorMessage} />;
  }
  // Autoplay belongs to the first entry that actually has audio — the most
  // exact match wins; shorter sub-term matches stay silent unless clicked.
  const firstAudioIdx = entries.findIndex(
    (f) => audioItemForEntry(f, audioMedia) !== null,
  );
  return entries.map((f, i) => (
    <div key={`${keyPrefix}:${term}:${i}`} className="popover-entry">
      <TermDefinition
        term={term}
        state="loaded"
        fields={f}
        onCrossRef={onCrossRef}
        actions={
          <>
            <PopoverAudio
              item={audioItemForEntry(f, audioMedia)}
              autoplay={autoplay && i === firstAudioIdx}
              volume={audioVolume}
            />
            {ankiConfig ? (
              <PopoverAddToAnki
                term={f.expression || term}
                fields={f}
                audioMedia={mediaForFields(f, audioMedia)}
                dictionaryMedia={mediaForFields(f, dictionaryMedia)}
                sentence={sentence}
                config={ankiConfig}
                triggerNonce={i === 0 ? ankiTriggerNonce : undefined}
              />
            ) : null}
          </>
        }
      />
    </div>
  ));
}

export default PopoverApp;

import { invoke } from "@tauri-apps/api/core";
/* eslint react-hooks/preserve-manual-memoization: "off" -- The imported popup derives mutable display locals; this build does not enable React Compiler. */
import { useCallback, useEffect, useRef, useState } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { ArrowLeft } from "lucide-react";
import { Button } from "@kit";
import { PopoverAudio } from "@texthooker/components/PopoverAudio";
import {
  PopoverAddToAnki,
  type AnkiConfig,
} from "@texthooker/components/PopoverAddToAnki";
import { TermDefinition } from "@texthooker/components/TermDefinition";
import { NotebookEntryCard } from "@texthooker/components/NotebookEntryCard";
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
    ) => {
      const registration = listen<T>(event, handler);
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
      // A new lookup starts with a "loading" payload (notebook payloads arrive
      // standalone). Reset the Cmd+Enter nonce so a leftover value can't
      // auto-fire an Anki add when the new term's (keyed, freshly mounted)
      // entry buttons appear, and discard any followed cross-reference links so
      // a re-hover shows the freshly-scanned term — not where we drilled to.
      if (e.payload.kind === "loading" || e.payload.kind === "notebook") {
        setAnkiTriggerNonce(undefined);
        xrefGen.current += 1;
        setXrefStack([]);
      }
      // Show window if hidden (Rust also shows it; both are idempotent).
      setVisible(true);
    });

    void register<unknown>("popover:hide", () => {
      setVisible(false);
    });

    // Mirror the main window's resolved theme onto our document root.
    void register<ResolvedTheme>("popover:theme", (e) => {
      document.documentElement.dataset.theme = e.payload;
    });

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
        void invoke("hide_popover");
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

  // When the user moves the cursor over the popover, take focus so clicks,
  // scroll, and Esc work on it. (Rust shows the window without focus by default
  // so it doesn't steal focus during scan-mode glides.)
  useEffect(() => {
    const onEnter = () => {
      void invoke("reader_popup_focus");
    };
    window.addEventListener("mouseenter", onEnter);
    return () => window.removeEventListener("mouseenter", onEnter);
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

  // Autoplay belongs to the first entry that actually has audio — the most
  // exact match wins; shorter sub-term matches stay silent unless clicked.
  const firstAudioIdx =
    state === "loaded"
      ? entries.findIndex((f) => audioItemForEntry(f, audioMedia) !== null)
      : -1;

  return (
    <div className={`popover-shell ${visible ? "visible" : ""}`}>
      <div className="popover-card">
        <div className="popover-scroll">
          {isNotebook && notebookEntry ? (
            <NotebookEntryCard
              entry={notebookEntry}
              onEdit={(entryId) => {
                // Hand off to the main window: it opens the edit modal (and
                // the notebook drawer) and focuses itself; we just disappear.
                void emit("notebook:edit-request", { entryId });
                setVisible(false);
                void invoke("hide_popover");
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
              {state === "loaded" ? (
                entries.map((f, i) => (
                  <div
                    key={`${xrefStack.length}:${term}:${i}`}
                    className="popover-entry"
                  >
                    <TermDefinition
                      term={term}
                      state="loaded"
                      fields={f}
                      onCrossRef={baseUrl ? followCrossRef : undefined}
                      actions={
                        <>
                          <PopoverAudio
                            item={audioItemForEntry(f, audioMedia)}
                            autoplay={audioAutoplay && i === firstAudioIdx}
                            volume={audioVolume}
                          />
                          {ankiConfig ? (
                            <PopoverAddToAnki
                              term={f.expression || term}
                              fields={f}
                              audioMedia={mediaForFields(f, audioMedia)}
                              dictionaryMedia={mediaForFields(
                                f,
                                dictionaryMedia,
                              )}
                              sentence={sentence}
                              config={ankiConfig}
                              triggerNonce={
                                i === 0 && !activeXref
                                  ? ankiTriggerNonce
                                  : undefined
                              }
                            />
                          ) : null}
                        </>
                      }
                    />
                  </div>
                ))
              ) : (
                <TermDefinition
                  term={term}
                  state={state}
                  errorMessage={errorMessage}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default PopoverApp;

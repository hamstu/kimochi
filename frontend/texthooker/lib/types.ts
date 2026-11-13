/* Shared TypeScript types. */
import { API_URLS } from "../../vendor/shared-constants";
import type { TranslationProvider } from "../../../ui/account";
import { DEFAULT_JAPANESE_FILTER, type JapaneseFilterMode } from "../../../ui/japanese-text";
import { defaultExplainPrompt } from "./explainPrompt";

export type { TranslationProvider };

/** Where a line came from. `cli` is `kimochi log add` (src-tauri/src/cli/), taken whatever the input is. */
/** Where a line came from. "note" is one the person wrote in the Log (Add a note), in Markdown. */
export type LineSource = "webhook" | "clipboard" | "ocr" | "websocket" | "hook" | "cli" | "note";

/** A line the person wrote (Add a note), not one that was read. */
export function isNote(line: { source: LineSource }): boolean {
  return line.source === "note";
}

export interface Line {
  ocr?: { scanId: string; groupId: string; groupIndex: number; groupCount: number; engine?: string; orientation: "horizontal" | "vertical" };
  /** Durable OCR replay IDs; separate from optional text-based deduplication. */
  ingestIds?: string[];
  /** Numbers the line within its session on this computer (another computer's lines are
      renumbered as they arrive). */
  id: number;
  /** Identifies the line across computers for Sync. Lines written before uids existed are given
      one derived from their session, id, time and text (`derivedLineUid`). */
  uid?: string;
  /** What the line says: as recorded, or as the person corrected it (Edit line). */
  text: string;
  /** The text as recorded, kept once the line has been edited (absent while it hasn't). Ingest
      compares new text with this (`recordedText`). */
  originalText?: string;
  source: LineSource;
  ts: number;
  /** Cached DeepL translation. Persisted with lines.json so a line is only
      ever sent to the API once. */
  translation?: string;
  /** When true (and `translation` is set), the row renders the English text
      instead of the tokenized/highlighted Japanese. */
  showTranslation?: boolean;
  /** Cached LLM explanation (markdown). Persisted with lines.json; the
      Explain modal shows this instantly and offers Regenerate. */
  explanation?: string;
}

/** "kimochi" streams from Kimochi cloud (needs a signed-in account); the others run a local CLI. */
export type ExplainProvider = "codex" | "claude" | "kimochi";

export type ThemePref = "dark" | "light" | "system";
export type ResolvedTheme = "dark" | "light";

export type UiScale = "small" | "medium" | "large" | "xlarge";

/** The root font size every rem-based UI dimension is measured against. */
export const UI_BASE_FONT_PX = 16;

/** Multipliers applied to `UI_BASE_FONT_PX`. "small" is 1 — the app's original
    sizing — so existing installs look unchanged until the user opts in. */
export const UI_SCALE_FACTORS: Record<UiScale, number> = {
  small: 1,
  medium: 1.15,
  large: 1.3,
  xlarge: 1.5,
};

export const UI_SCALE_LABELS: Record<UiScale, string> = {
  small: "Small",
  medium: "Medium",
  large: "Large",
  xlarge: "Extra large",
};

export interface Settings {
  inputSource: "ocr" | "clipboard" | "websocket" | "hook" | "browser";
  websocketUrl: string;
  dictionaryMode: "builtin" | "custom-api";
  autoMatchSource: boolean;
  version: number;
  yomitanApiUrl: string;
  webhookPort: number;
  fontSizePx: number;
  alwaysOnTop: boolean;
  clipboardEnabled: boolean;
  clipboardPollMs: number;
  popoverWidth: number;
  popoverHeight: number;

  // Theme (Bucket 4)
  theme: ThemePref;

  /** Scales every rem-sized UI dimension (chrome, panels, modals, controls).
      Deliberately does NOT touch transcript text — that has its own
      `fontSizePx` — nor the popover window, which has its own A+/A- control. */
  uiScale: UiScale;

  // Stats (Bucket 1)
  afkThresholdSec: number;
  statsShowTime: boolean;
  statsShowLines: boolean;
  statsShowChars: boolean;
  statsShowSpeed: boolean;

  // Dedupe + line management (Bucket 3)
  dedupeDepth: number;
  /** Which lines to drop for not being Japanese, here and on the overlay (ui/japanese-text.ts). */
  japaneseFilter: JapaneseFilterMode;
  startMergeEnabled: boolean;
  startMergePrefixLen: number;
  maxLines: number;

  // Audio playback in popover (v3)
  audioEnabled: boolean;
  audioAutoplay: boolean;
  audioVolume: number; // 0..1

  // Anki mining (v3)
  ankiEnabled: boolean;
  ankiConnectUrl: string;
  /** AnkiConnect's apiKey, when it has one. Private: never synced (profile.rs `is_private`). */
  ankiConnectKey: string;
  ankiDeckName: string | null;
  ankiModelName: string | null;
  /** Cached field order from AnkiConnect for the chosen model; kept fresh by
      the AnkiSetup UI. Send path uses this to know which fields to populate. */
  ankiModelFields: string[];
  ankiFieldMappings: AnkiFieldMapping[];
  /** No longer used: card enhancement's tags (`cardTags`) tag every card, and a settings file
      from before them moves these there (src-tauri/src/settings.rs). */
  ankiTags: string[];

  // Translation (DeepL with the user's key, or Kimochi cloud with an account)
  /** Who translates: "auto" is Kimochi cloud while signed in, otherwise the DeepL key. */
  translationProvider: TranslationProvider;
  /** Stored only in settings.json (AppLocalData) — never bundled or committed. */
  deeplApiKey: string;

  // Explain (local LLM CLI)
  explainProvider: ExplainProvider;
  /** Model alias/id passed to `claude --model` (e.g. "opus", "sonnet"). */
  explainClaudeModel: string;
  /** Model passed to `codex exec -m`. Empty = the CLI's default model. */
  explainCodexModel: string;
  /** Prompt template; {{language}}, {{context}} and {{sentence}} are substituted. A default
      (explainPrompt.ts) follows the language; anything else is sent as written. */
  explainPrompt: string;
}

/** The default Explain prompt as stored: the Japanese template, which follows the language
    (explainPrompt.ts; a stored default, or the pre-language one, is treated as "default"). */
export const DEFAULT_EXPLAIN_PROMPT = defaultExplainPrompt();

/** Each row maps one field of the chosen Anki note type to a source. */
export interface AnkiFieldMapping {
  ankiField: string;
  /** "sentenceAudio": the line's recorded audio, added once the card is (sentenceAudio.ts).
      "wordAudio": the mined word's, cut out of it. */
  mappingType: "marker" | "sentence" | "sentenceAudio" | "wordAudio" | "literal" | "empty";
  /** When mappingType="marker", a key into YomitanAnkiFields. */
  marker?: string;
  /** When mappingType="literal", verbatim text. */
  literal?: string;
}

export const SETTINGS_DEFAULTS: Settings = {
  inputSource: "ocr",
  websocketUrl: "ws://localhost:6677",
  dictionaryMode: "builtin",
  autoMatchSource: true,
  version: 3,
  yomitanApiUrl: API_URLS.YOMITAN,
  webhookPort: 7890,
  fontSizePx: 14,
  alwaysOnTop: false,
  clipboardEnabled: false,
  clipboardPollMs: 200,
  popoverWidth: 480,
  popoverHeight: 360,

  theme: "system",
  uiScale: "small",

  afkThresholdSec: 60,
  statsShowTime: true,
  statsShowLines: true,
  statsShowChars: true,
  statsShowSpeed: true,

  dedupeDepth: 1,
  japaneseFilter: DEFAULT_JAPANESE_FILTER,
  startMergeEnabled: false,
  startMergePrefixLen: 4,
  maxLines: 5000,

  audioEnabled: true,
  audioAutoplay: true,
  audioVolume: 0.9,

  ankiEnabled: false,
  ankiConnectUrl: "http://127.0.0.1:8765",
  ankiConnectKey: "",
  ankiDeckName: null,
  ankiModelName: null,
  ankiModelFields: [],
  ankiFieldMappings: [],
  ankiTags: [],

  translationProvider: "auto",
  deeplApiKey: "",

  explainProvider: "codex",
  explainClaudeModel: "opus",
  explainCodexModel: "",
  explainPrompt: DEFAULT_EXPLAIN_PROMPT,
};

export type AnkiStatus = "ok" | "err" | "unknown";

/** Yomitan field markers we request via /ankiFields. Keep in sync with
    src-tauri/src/yomitan.rs::ANKI_MARKERS. */
export const YOMITAN_MARKERS: readonly string[] = [
  "expression",
  "reading",
  "glossary",
  "dictionary",
  "frequencies",
  "pitch-accents",
  "part-of-speech",
  "tags",
  "conjugation",
  "audio",
  "sentence",
  "sentence-furigana",
];

/** Markers Yomitan fills for Japanese only (pitch accent, sentence furigana): left out of the
    field-mapping list and Detect's mappings for other languages. A saved mapping still works. */
export const JAPANESE_ONLY_MARKERS: readonly string[] = ["pitch-accents", "sentence-furigana"];

/** The markers offered for mapping while reading Japanese (`japanese`) or another language. */
export const markersFor = (japanese: boolean): readonly string[] =>
  japanese ? YOMITAN_MARKERS : YOMITAN_MARKERS.filter((m) => !JAPANESE_ONLY_MARKERS.includes(m));

/** Markers a field can map to beyond YOMITAN_MARKERS, which Kimochi's pop-up fills itself. */
export const LOCAL_MARKERS: readonly string[] = ["popup-selection-text"];

/* Stats (Bucket 1) */

export interface Stats {
  version: 1;
  totalMs: number;
  totalChars: number;
  /** Words read, counted only while reading a language that spaces its words (the footer then
      shows words and words/h). Absent in stats from before, or only ever in Japanese. */
  totalWords?: number;
  totalLines: number;
  lastUpdateTs: number;
}

export const STATS_DEFAULTS: Stats = {
  version: 1,
  totalMs: 0,
  totalChars: 0,
  totalLines: 0,
  lastUpdateTs: 0,
};

/* Replacements + Presets (Bucket 2) */

export interface Replacement {
  id: string;
  pattern: string;
  flags: string;
  replacement: string;
  enabled: boolean;
}

export interface Preset {
  settings: Settings;
  replacements: Replacement[];
}

export interface PresetsFile {
  version: 1;
  active: string;
  presets: Record<string, Preset>;
}

/* Yomitan response shapes (loose — what we actually use). */

export interface YomitanAnkiFields {
  expression?: string;
  reading?: string;
  glossary?: string;
  dictionary?: string;
  frequencies?: string;
  "pitch-accents"?: string;
  "part-of-speech"?: string;
  tags?: string;
  conjugation?: string;
  audio?: string;
  sentence?: string;
  "sentence-furigana"?: string;
  /** Not from /ankiFields: the pop-up's selection, filled in as a card is added. */
  "popup-selection-text"?: string;
}

/** Base64-encoded media file bundled with /ankiFields when includeMedia=true. */
export interface AnkiMediaItem {
  ankiFilename: string;
  contentBase64: string;
}

export interface YomitanAnkiFieldsResponse {
  fields: YomitanAnkiFields[];
  audioMedia: AnkiMediaItem[];
  dictionaryMedia: AnkiMediaItem[];
}

export interface YomitanTermResult {
  fields: YomitanAnkiFields | null;
  audioMedia: AnkiMediaItem[];
  dictionaryMedia: AnkiMediaItem[];
}

/** Like YomitanTermResult but keeps every matched entry (longest match first),
    mirroring the popover's multi-entry display. Used when a glossary
    cross-reference link is followed and the popover content is swapped. */
export interface YomitanAllEntriesResult {
  entries: YomitanAnkiFields[];
  audioMedia: AnkiMediaItem[];
  dictionaryMedia: AnkiMediaItem[];
}

/** Tauri event payload from the webhook server. */
export interface WebhookLineEvent {
  text: string;
  ts: number;
}

export interface WebhookErrorEvent {
  code: string;
  message: string;
  port: number;
}

export type YomitanStatus = "ok" | "err" | "unknown";

/* Sessions (Bucket 5) */

export interface SessionMeta {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionsManifest {
  version: 1;
  activeId: string;
  sessions: SessionMeta[];
}

export function defaultSessionName(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `Session ${y}-${m}-${day}`;
}

/* Notebook */

export type NotebookKind = "person" | "place" | "thing";

export interface NotebookImage {
  id: string;
  /** Relative to AppLocalData, e.g. "sessions/<sid>/images/<uuid>.png". */
  path: string;
  width?: number;
  height?: number;
  addedAt: number;
}

/** A short personal comment attached to an entry — separate from the
    description, which may be owned by a VNDB import. */
export interface NotebookNote {
  id: string;
  text: string;
  createdAt: number;
  updatedAt: number;
}

interface NotebookEntryBase {
  id: string;
  kind: NotebookKind;
  description: string;
  notes: NotebookNote[];
  images: NotebookImage[];
  matchEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** VNDB id (e.g. "c547") when this entry was created or adopted by a VNDB
      import. Lets re-imports find the exact entry regardless of renames. */
  vndbId?: string;
  /** Description text as last written by a VNDB import. Re-import overwrites
      the description only while it still equals this value, so hand edits
      are never clobbered. */
  importedDescription?: string;
}

export interface PersonEntry extends NotebookEntryBase {
  kind: "person";
  family: string;
  given: string;
  familyReading?: string;
  givenReading?: string;
  /** When true, also match the given name alone. */
  matchGivenAlone: boolean;
  aliases: string[];
}

export interface PlaceOrThingEntry extends NotebookEntryBase {
  kind: "place" | "thing";
  name: string;
  reading?: string;
  aliases: string[];
}

export type NotebookEntry = PersonEntry | PlaceOrThingEntry;

export interface NotebookFile {
  /** v2 adds per-entry notes and flips matchGivenAlone on by default. */
  version: 1 | 2;
  /** Bumps on every edit so render-time match memoization invalidates. */
  cacheVersion: number;
  entries: NotebookEntry[];
}

export const NOTEBOOK_EMPTY: NotebookFile = {
  version: 2,
  cacheVersion: 0,
  entries: [],
};

/** Snapshot of a notebook entry shipped through the popover event. */
export interface SerializedNotebookEntry {
  id: string;
  kind: NotebookKind;
  /** Preferred display form (full name for person; name for place/thing). */
  displayName: string;
  reading?: string;
  description: string;
  aliases: string[];
  /** Note texts, newest last. */
  notes: string[];
  /** First image as a data URL, or null. */
  imageDataUrl: string | null;
}

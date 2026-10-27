/**
 * Data for the /compare page. Edit cells here; the page renders whatever is in this file.
 *
 * Every cell is `{ text, verified? }`. Leave `verified` out (or `true`) when the claim was checked
 * against the tool's own repo, site or docs (listed in `SOURCES`). Set `verified: false` for
 * anything inferred, reported by third parties, or simply not documented: the page shows a small
 * "unverified" tag next to it. Researched 2026-10-09; YomiNinja added 2026-10-21 from its README,
 * releases and repository metadata only.
 */

export type ToolId = "kimochi" | "kamui" | "gsm" | "owocr" | "yomininja";

export interface Cell {
  text: string;
  /** False when the claim could not be confirmed from the tool's own sources. */
  verified?: boolean;
}

export interface Tool {
  id: ToolId;
  name: string;
  /** Short name for the table header. */
  short: string;
  url: string;
}

export interface Row {
  label: string;
  cells: Record<ToolId, Cell>;
}

export interface Source {
  label: string;
  url: string;
}

export const RESEARCHED = "2026-10-09";

export const TOOLS: Tool[] = [
  {
    id: "kimochi",
    name: "Kimochi",
    short: "Kimochi",
    url: "https://github.com/hamstu/kimochi",
  },
  { id: "kamui", name: "Kamui", short: "Kamui", url: "https://kamui.gg" },
  {
    id: "gsm",
    name: "Game Sentence Miner",
    short: "GSM",
    url: "https://github.com/bpwhelan/GameSentenceMiner",
  },
  {
    id: "owocr",
    name: "owocr",
    short: "owocr",
    url: "https://github.com/AuroraWright/owocr",
  },
  {
    id: "yomininja",
    name: "YomiNinja",
    short: "YomiNinja",
    url: "https://github.com/matt-m-o/YomiNinja",
  },
];

export const ROWS: Row[] = [
  {
    label: "Platforms",
    cells: {
      kimochi: {
        text: "macOS 14+ (most mature), Windows, Linux. Steam Deck Gaming Mode is in early testing.",
      },
      kamui: {
        text: "Web app in the browser, plus a Windows-only desktop app marked experimental.",
      },
      gsm: {
        text: "Windows, macOS, Linux. Steam Deck in Desktop Mode (Game Mode not supported), or streamed from a PC.",
      },
      owocr: {
        text: "Windows, macOS, Linux (Python 3.11 to 3.14). Linux works best on Wayland; X11 is partial.",
      },
      yomininja: {
        text: "Windows 10/11, macOS (Intel and Apple silicon), Linux x64. Built for X11; Wayland support is initial.",
      },
    },
  },
  {
    label: "Capture method",
    cells: {
      kimochi: {
        text: "Built-in screen or window capture with a crop region. No OBS needed.",
      },
      kamui: {
        text: "Desktop app captures the game screen; the capture method is not documented.",
        verified: false,
      },
      gsm: {
        text: "OBS Studio (required, also used for screenshots and audio); OCR can also use native screen capture.",
      },
      owocr: {
        text: "Screen area or window capture, OBS, or images from the clipboard, a folder or a socket.",
      },
      yomininja: {
        text: "The whole screen or one window, with OCR Templates for fixed text regions.",
      },
    },
  },
  {
    label: "OCR engines",
    cells: {
      kimochi: {
        text: "Google Lens (the default), Apple Live Text (macOS), MeikiOCR, Manga OCR, or OneOCR (Windows).",
      },
      kamui: { text: "Google Cloud Vision (cloud)." },
      gsm: {
        text: "A fork of owocr. Local: OneOCR, Screen AI, MeikiOCR, Apple Live Text, local LLM, MLKit. Cloud: Google Lens, Bing, Gemini, Google Vision, Azure, OCRSpace.",
      },
      owocr: {
        text: "Local: Chrome Screen AI, OneOCR, Apple Live Text, Apple Vision, meikiocr, NDLOCR-Lite, Manga OCR, WinRT, EasyOCR, RapidOCR. Cloud: Google Lens, Bing, Google Vision, Azure, OCRSpace.",
      },
      yomininja: {
        text: "PaddleOCR, Manga OCR, Apple Vision (macOS), Google Lens, Google Cloud Vision.",
      },
    },
  },
  {
    label: "Overlay on the game",
    cells: {
      kimochi: {
        text: "Yes: recognised text drawn over the game, selectable for lookups (not with owocr input, which returns text only).",
      },
      kamui: { text: "Yes, in the desktop app (experimental)." },
      gsm: {
        text: "Yes: hover lookups with Yomitan, in-game card creation, optional furigana.",
      },
      owocr: {
        text: "None documented; owocr outputs text for other tools.",
        verified: false,
      },
      yomininja: {
        text: "Yes: extracted text over the screen for pop-up dictionary lookups; optional furigana filter; experimental browser overlay.",
      },
    },
  },
  {
    label: "Texthooker, clipboard, WebSocket input",
    cells: {
      kimochi: {
        text: "Clipboard and WebSocket text inputs alongside OCR; can also send OCR text to the clipboard or a WebSocket.",
      },
      kamui: { text: "Not documented.", verified: false },
      gsm: {
        text: "Yes: hooks from Agent, Textractor or LunaTranslator, plus clipboard; built-in texthooker page.",
      },
      owocr: {
        text: "Takes images in (clipboard, WebSocket, folder); sends text out to the clipboard, a WebSocket or a file.",
      },
      yomininja: {
        text: "WebSocket for texthooker pages (sends OCR text out). Clipboard and text input not documented.",
      },
    },
  },
  {
    label: "Dictionary lookup",
    cells: {
      kimochi: {
        text: "Built-in Yomitan, Hachidori or 10ten, with dictionaries you import or download, or the Yomitan in your browser through the Yomitan API.",
      },
      kamui: {
        text: "Built-in dictionary sidebar with context-aware lookups; AI translation.",
      },
      gsm: {
        text: "Yomitan (in the overlay and texthooker); Jiten Reader in the overlay.",
      },
      owocr: {
        text: "None built in; usually paired with a texthooker page and Yomitan.",
      },
      yomininja: {
        text: "Browser-extension dictionaries built in: Yomitan and 10ten pre-installed, other Chrome extensions partly supported.",
      },
    },
  },
  {
    label: "Anki integration",
    cells: {
      kimochi: {
        text: "Yes, through AnkiConnect, with the mined line's voice cut from system audio and trimmed to the speech.",
      },
      kamui: {
        text: "Yes: one-click add from a dictionary entry, to your deck or a Kamui deck.",
      },
      gsm: {
        text: "Its focus: enriches cards with the voiced line (trimmed by voice detection), screenshots or GIFs, and optional AI translation.",
      },
      owocr: { text: "None built in." },
      yomininja: {
        text: "Not built in; listed as a planned feature.",
      },
    },
  },
  {
    label: "Automatic / continuous OCR",
    cells: {
      kimochi: {
        text: "Yes: Auto OCR with change detection and adaptive polling.",
      },
      kamui: { text: "Yes, in the desktop app (experimental)." },
      gsm: {
        text: "Yes: two-pass, a fast local scan then a more accurate scan once text settles.",
      },
      owocr: {
        text: "Yes: continuous scanning, repeated-text filtering, optional two-pass.",
      },
      yomininja: {
        text: "Yes: Auto OCR re-reads an OCR Template region when it changes (experimental, one region at a time).",
      },
    },
  },
  {
    label: "Controller and handheld",
    cells: {
      kimochi: {
        text: "Gamepad buttons drive the overlay menu and word lookups; Steam Deck Gaming Mode support is early.",
      },
      kamui: { text: "Not documented.", verified: false },
      gsm: {
        text: "Experimental gamepad navigation of the overlay; Deck in Desktop Mode.",
      },
      owocr: { text: "Not documented.", verified: false },
      yomininja: {
        text: "Not documented.",
        verified: false,
      },
    },
  },
  {
    label: "Price and licence",
    cells: {
      kimochi: { text: "Free. GPL-3.0." },
      kamui: {
        text: "Paid subscription ($5/month shown; yearly and lifetime options). Closed source. Users report a limited free allowance.",
        verified: false,
      },
      gsm: { text: "Free. GPL-3.0; accepts sponsorship." },
      owocr: { text: "Free. GPL-3.0." },
      yomininja: {
        text: "Free. GPL-3.0.",
      },
    },
  },
  {
    label: "Project status",
    cells: {
      kimochi: { text: "Young and actively developed, by one developer." },
      kamui: {
        text: "Commercial product from Kamui, LLC; desktop app labelled experimental.",
      },
      gsm: { text: "Active: release v2026.10.0 on 2026-10-04." },
      owocr: {
        text: "Active: release 1.26.8 on 2026-03-28, commits into June 2026.",
      },
      yomininja: {
        text: "Latest release v0.9.3 on 2025-08-04; no commits since.",
      },
    },
  },
];

export const SOURCES: Source[] = [
  {
    label: "owocr: README (AuroraWright/owocr)",
    url: "https://github.com/AuroraWright/owocr",
  },
  {
    label: "owocr: releases",
    url: "https://github.com/AuroraWright/owocr/releases",
  },
  {
    label: "Game Sentence Miner: README",
    url: "https://github.com/bpwhelan/GameSentenceMiner",
  },
  {
    label: "Game Sentence Miner: overview",
    url: "https://docs.gamesentenceminer.com/docs/overview",
  },
  {
    label: "Game Sentence Miner: OCR",
    url: "https://docs.gamesentenceminer.com/docs/features/ocr",
  },
  {
    label: "Game Sentence Miner: overlay gamepad navigation",
    url: "https://docs.gamesentenceminer.com/docs/features/overlay-gamepad",
  },
  {
    label: "Game Sentence Miner: Steam Deck",
    url: "https://docs.gamesentenceminer.com/docs/getting-started/deck",
  },
  {
    label: "Game Sentence Miner: releases",
    url: "https://github.com/bpwhelan/GameSentenceMiner/releases",
  },
  { label: "Kamui: home page and FAQ", url: "https://kamui.gg" },
  { label: "Kamui: pricing", url: "https://kamui.gg/pricing" },
  {
    label: "Kamui: Nookgaming review",
    url: "https://www.nookgaming.com/kamui-the-easiest-way-to-learn-japanese-game-translation-flashcards-more/",
  },
  {
    label: "Kamui: Bunpro community thread (free allowance report)",
    url: "https://community.bunpro.jp/t/ocr-for-games-ai-for-speaking-practice/202891",
  },
  {
    label: "YomiNinja: README (matt-m-o/YomiNinja)",
    url: "https://github.com/matt-m-o/YomiNinja",
  },
  {
    label: "YomiNinja: releases (v0.9.3, v0.9.1 Wayland, v0.8.3 overlay, v0.7.2 Auto OCR)",
    url: "https://github.com/matt-m-o/YomiNinja/releases",
  },
  { label: "Kimochi: source", url: "https://github.com/hamstu/kimochi" },
];

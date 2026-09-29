import type { LineSource, Settings } from "./lib/types";

export type InputSource = "ocr" | "clipboard" | "websocket";

/** Legacy clipboard users retain that choice; all other existing installs use OCR. */
export function inputSourceOf(settings: Partial<Settings>): InputSource {
  if (["ocr", "clipboard", "websocket"].includes(settings.inputSource || "")) {
    return settings.inputSource as InputSource;
  }
  return settings.clipboardEnabled ? "clipboard" : "ocr";
}

export function acceptsInput(
  settings: Partial<Settings>,
  source: LineSource,
): boolean {
  return inputSourceOf(settings) === source;
}

/** Text-only input: raw messages, JSON strings, or common text/sentence envelopes. */
export function socketText(data: unknown): string | null {
  if (typeof data !== "string" || data.length > 1_000_000) return null;
  const trimmed = data.trim();
  if (!trimmed) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const message = value as Record<string, unknown>;
      return typeof message.text === "string"
        ? message.text
        : typeof message.sentence === "string"
          ? message.sentence
          : null;
    }
    return null;
  } catch {
    // Broken protocol envelopes must not turn into transcript lines.
    if (/^[{[]/.test(trimmed)) return null;
    return data;
  }
}

export function socketUrl(value: string): string {
  const url = new URL(value);
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error("Use a ws:// or wss:// address without credentials.");
  }
  return url.href;
}

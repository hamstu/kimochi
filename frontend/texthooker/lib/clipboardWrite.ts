import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** The most recent text WE wrote to the clipboard. The clipboard poll consults
 *  this so it can suppress re-ingesting text the user copied from inside our
 *  own app (e.g. via the line actions menu or browser context menu copy). */
let lastSelfWrite: string | null = null;

/** Write `text` to the system clipboard AND mark it as self-originated so the
 *  clipboard poll won't ingest it. Use this instead of calling writeText
 *  directly anywhere inside the app. */
export async function writeTextSelf(text: string): Promise<void> {
  // Mark BEFORE the write so a fast poll tick can still consult it; the poll
  // also runs after the read, so it's a small race-free window in practice.
  lastSelfWrite = text;
  await writeText(text);
}

/** Returns true if `text` matches the most recent self-write. Clears the
 *  marker so the next genuinely-different clipboard change is not suppressed. */
export function consumeIfSelfWrite(text: string): boolean {
  if (lastSelfWrite !== null && text === lastSelfWrite) {
    lastSelfWrite = null;
    return true;
  }
  return false;
}

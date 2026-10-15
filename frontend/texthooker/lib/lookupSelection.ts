/**
 * Selects the text the dictionary pop-up is defining, as Yomitan and the other pop-up
 * dictionaries do, and clears that selection again when the pop-up closes. A selection the user
 * made themselves in the meantime is left alone.
 */
import { listen } from "@tauri-apps/api/event";

let selected: Range | null = null;

function isOurs(selection: Selection): boolean {
  if (!selected || selection.rangeCount !== 1) return false;
  const current = selection.getRangeAt(0);
  return (
    current.startContainer === selected.startContainer &&
    current.startOffset === selected.startOffset &&
    current.endContainer === selected.endContainer &&
    current.endOffset === selected.endOffset
  );
}

/** Selects `range` (the word being looked up). */
export function selectLookup(range: Range): void {
  const selection = window.getSelection();
  if (!selection || !range.startContainer.isConnected) return;
  selection.removeAllRanges();
  selection.addRange(range);
  selected = range.cloneRange();
}

/** Clears the looked-up word's selection, if it is still the selection. */
export function clearLookupSelection(): void {
  const selection = window.getSelection();
  if (selection && isOurs(selection)) selection.removeAllRanges();
  selected = null;
}

/** Clears the selection whenever the pop-up closes. Returns the unsubscribe. */
export function clearLookupSelectionOnHide(): () => void {
  const pending = listen("popover:hide", () => clearLookupSelection());
  return () => void pending.then((stop) => stop());
}

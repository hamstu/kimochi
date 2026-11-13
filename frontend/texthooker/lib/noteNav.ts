import type { MouseEvent } from "react";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import type { Line } from "./types";

/**
 * Requests that cross between the Log and the Notebook, which are separate views of the main
 * window: show a line in the Log (Show in Log, from a note in the Notebook), and open the
 * Notebook on the person's notes (the Log footer's note count). Each waits for its view to take
 * it, since a view may be hidden (the Log) or not mounted yet (the Notebook) when it is made.
 */

/** A Notebook item id for a note: `note:` and its line's uid. Entries' ids never take this form. */
export const NOTE_ITEM = "note:";

export function noteItemId(line: Pick<Line, "uid" | "id">): string {
  return `${NOTE_ITEM}${line.uid ?? line.id}`;
}

export function isNoteItemId(id: string | null | undefined): id is string {
  return Boolean(id?.startsWith(NOTE_ITEM));
}

/** The note a Notebook item id names, among `lines`. */
export function noteForItem(lines: readonly Line[], id: string): Line | undefined {
  const key = id.slice(NOTE_ITEM.length);
  return lines.find((line) => line.source === "note" && (line.uid ?? String(line.id)) === key);
}

type Listener = () => void;

let reveal: string | null = null;
const revealSubs = new Set<Listener>();

/** Asks the Log to bring the line with this uid into view and mark it. */
export function revealLine(uid: string): void {
  reveal = uid;
  for (const fn of revealSubs) fn();
}

/** The line the Log has been asked to show, taken (cleared) by the Log once it has shown it. */
export function pendingReveal(): string | null {
  return reveal;
}

export function takeReveal(): void {
  reveal = null;
}

export function onRevealRequest(fn: Listener): () => void {
  revealSubs.add(fn);
  return () => revealSubs.delete(fn);
}

let notesFilter = false;
const filterSubs = new Set<Listener>();

/** Asks the Notebook to show the person's notes (it takes this as it mounts, or at once). */
export function requestNotesFilter(): void {
  notesFilter = true;
  for (const fn of filterSubs) fn();
}

/** True once per request. */
export function takeNotesFilter(): boolean {
  const asked = notesFilter;
  notesFilter = false;
  return asked;
}

export function onNotesFilterRequest(fn: Listener): () => void {
  filterSubs.add(fn);
  return () => filterSubs.delete(fn);
}

/**
 * A click on a link in a rendered note: web links open in the browser, never in the window; any
 * other link does nothing. True when the click was on a link (and has been handled).
 */
export function followNoteLink(event: MouseEvent): boolean {
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (!link) return false;
  event.preventDefault();
  if (/^https?:/i.test(link.href)) void openUrl(link.href).catch(() => {});
  return true;
}

/** A note's first line, without Markdown's marks: its title in lists. */
export function noteTitle(text: string): string {
  const first = text.split("\n").find((line) => line.trim()) ?? "";
  return first
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim();
}

/** The rest of a note after its first line, on one line: its preview in lists. */
export function noteRest(text: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.trim());
  return lines
    .slice(first + 1)
    // A divider (---, ***, ___) is layout, not words.
    .filter((line) => !/^\s*([-*_])(\s*\1){2,}\s*$/.test(line))
    .join(" ")
    .replace(/[#>*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

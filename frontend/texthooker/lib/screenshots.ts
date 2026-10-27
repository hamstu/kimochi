/* screenshots.ts — the Log's side of screenshots (src-tauri/src/screenshots.rs): each OCR scan's
   source, kept whole with what OCR read on it. Every line a scan produced shows the same
   screenshot; the viewer steps through them all, oldest to newest. The pop-up's cards ask for
   theirs once added. */

import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Line } from "./types";

/** Where OCR read text: `bbox` `[x0, y0, x1, y1]` in the screenshot's pixels. */
export interface ShotMark {
  text: string;
  bbox: [number, number, number, number];
  vertical?: boolean;
}

/** One scan's screenshot (`screenshots_list`, `screenshot-added`). */
export interface Shot {
  /** The scan: its lines' `ocr.scanId`. */
  scan: string;
  url: string;
  at: number;
  width: number;
  height: number;
  text: string;
  /** The OCR crop area `[x, y, width, height]` in the screenshot's pixels; null: the whole source. */
  crop: [number, number, number, number] | null;
  marks: ShotMark[];
}

/** The scan a Log line was read in: its OCR group's, or, for a scan read as one text, its own
    ingest id (host.ts). */
export function scanOf(line: Line): string | undefined {
  if (line.ocr?.scanId) return line.ocr.scanId;
  if (line.source !== "ocr") return undefined;
  return line.ingestIds?.[0]?.split(":group:")[0];
}

let shots: Shot[] = [];
const subscribers = new Set<() => void>();
let following = false;

function changed(): void {
  for (const notify of subscribers) notify();
}

function add(shot: Shot): void {
  shots = [...shots.filter((s) => s.scan !== shot.scan), shot].sort((a, b) => a.at - b.at);
  changed();
}

/** Follow new screenshots, starting from the ones kept. */
function follow(): void {
  if (following) return;
  following = true;
  try {
    listen<Shot>("screenshot-added", (event) => add(event.payload)).catch(() => {});
    invoke<Shot[]>("screenshots_list").then(
      (kept) => {
        const known = new Set(shots.map((s) => s.scan));
        shots = [...shots, ...kept.filter((s) => !known.has(s.scan))].sort((a, b) => a.at - b.at);
        changed();
      },
      () => {},
    );
  } catch {
    // No native bridge (a plain browser): no screenshots.
  }
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

/** Every kept screenshot, oldest first. */
export function useShots(): readonly Shot[] {
  follow();
  return useSyncExternalStore(subscribe, () => shots, () => shots);
}

/** Scan `scan`'s screenshot, while it is kept. */
export function useShot(scan: string | undefined): Shot | undefined {
  follow();
  return useSyncExternalStore(
    subscribe,
    () => (scan ? shots.find((s) => s.scan === scan) : undefined),
    () => undefined,
  );
}

/** The pop-up added note `noteId` from `sentence`: its scan's screenshot follows in the
    background, into `field` (a field mapped to the screenshot) or the one in Settings → Anki. */
export function attachScreenshot(
  url: string,
  noteId: number,
  sentence: string | null,
  scan: string | null = null,
  field: string | null = null,
): void {
  invoke("screenshot_attach", { url, noteId, sentence, scan, field }).catch(() => {});
}

/** The Anki tab's Add screenshot. */
export function addScreenshotToNote(noteId: number): Promise<void> {
  return invoke("screenshot_add_to_note", { noteId });
}

/** How the last card's screenshot went, for Settings. */
export function screenshotStatus(): Promise<{
  kept: number;
  last: { at: number; ok: boolean; message: string } | null;
}> {
  return invoke("screenshot_status");
}

// ---------------------------------------------------------------- the viewer

let open: string | null = null;
const viewerSubscribers = new Set<() => void>();

/** Open the viewer on scan `scan`'s screenshot; null closes it. */
export function showShot(scan: string | null): void {
  open = scan;
  for (const notify of viewerSubscribers) notify();
}

/** The scan whose screenshot the viewer shows. */
export function useOpenShot(): string | null {
  return useSyncExternalStore(
    (notify) => {
      viewerSubscribers.add(notify);
      return () => viewerSubscribers.delete(notify);
    },
    () => open,
    () => null,
  );
}

/** Test seam: replace the kept screenshots. */
export function setShotsForTest(next: Shot[]): void {
  following = true;
  shots = [...next].sort((a, b) => a.at - b.at);
  changed();
}

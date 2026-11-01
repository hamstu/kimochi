import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createScanner, type ScanPoint } from "@ui/scan-text";
import { desktopPointOf } from "@ui/desktop-point";
import type { AnkiConfig } from "@texthooker/components/PopoverAddToAnki";

/** How many pop-ups can stand on one another (`LEVELS` in src-tauri/src/reader/popover.rs). */
export const POPUP_LEVELS = 5;

/** Scanning works on any text in the card: the headword, the definitions and their examples. */
const SCAN_REGION_SELECTOR = ".popover-scroll";

/** Reading forward stops at the edge of one definition line, example or headword. */
const SCAN_BLOCK_SELECTOR = "li, p, td, th, .popover-headword-text, .popover-glossary";

/** How long a native pointer sample keeps this window's own mouse events out of the scan. */
const NATIVE_GRACE_MS = 500;

/** This window's place in the stack of pop-ups, from its label: `reader-popup` is 0, then
    `reader-popup-2` is 1, and so on. */
export function popupLevel(): number {
  let label = "reader-popup";
  try {
    label = getCurrentWebviewWindow().label;
  } catch {
    // No Tauri window (a plain browser page): the first pop-up.
  }
  const n = Number(/^reader-popup-(\d+)$/.exec(label)?.[1] ?? 1);
  return Number.isFinite(n) ? Math.max(0, n - 1) : 0;
}

/** What the pop-up on top is opened with: the same dictionary and settings as this one. */
export interface PopupLookup {
  baseUrl: string;
  includeMedia: boolean;
  audioAutoplay: boolean;
  audioVolume: number;
  ankiConfig: AnkiConfig | null;
}

interface NativePointer {
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  shift: boolean;
}

/**
 * Shift over a word in this pop-up opens the next pop-up on top of it, beside the word, as
 * Yomitan nests its pop-ups (up to `POPUP_LEVELS`). The same scanner as the Log's
 * (`scan-text.ts`), through the same Yomitan API.
 *
 * The pointer and Shift come from the native cursor poll (`popover:pointer`), which sends them to
 * the pop-up under the pointer whether or not it has the keyboard yet: a word scans the moment
 * the pointer is on it with Shift held, and the text underneath the pop-up never sees the scan.
 * Its own mouse events stand in where there is no native feed (Wayland). There a window without
 * the keyboard is not told Shift either, so Shift also comes from `linux-dictionary-modifier`
 * (GNOME Shell or the desktop's shortcut, as for Yomitan's own popups: host/linux-scan-input.js).
 */
export function usePopupScan(level: number, lookup: PopupLookup | null): void {
  const lookupRef = useRef(lookup);
  useEffect(() => {
    lookupRef.current = lookup;
  }, [lookup]);
  const baseUrl = lookup?.baseUrl ?? null;
  const canNest = level + 1 < POPUP_LEVELS;

  useEffect(() => {
    if (!baseUrl || !canNest) return;
    const scanner = createScanner({
      region: SCAN_REGION_SELECTOR,
      block: SCAN_BLOCK_SELECTOR,
      sentenceOf: (node) =>
        node.parentElement?.closest(SCAN_BLOCK_SELECTOR)?.textContent?.trim() ?? null,
      tokenize: (text, scanLength) =>
        invoke("yomitan_tokenize", { baseUrl, body: { text, scan_length: scanLength } }),
      show: ({ term, sentence, anchor, point }) => {
        const current = lookupRef.current;
        if (!current) return;
        const card = document.querySelector(".popover-card")?.getBoundingClientRect();
        invoke("show_popover", {
          term,
          cursorX: point.screenX,
          cursorY: point.screenY,
          anchor,
          width: card?.width ?? 480,
          height: card?.height ?? 360,
          baseUrl: current.baseUrl,
          focus: false,
          sentence,
          includeMedia: current.includeMedia,
          audioAutoplay: current.audioAutoplay,
          audioVolume: current.audioVolume,
          ankiConfig: current.ankiConfig,
          level: level + 1,
        }).catch((err) => console.warn("[popup scan] show_popover failed", err));
      },
    });

    let lastNative = -Infinity;
    /** Shift as the desktop reports it, where the window's own events cannot (Linux). */
    let desktopShift = false;
    /** The pointer's last place from this window's own events, for a Shift press without a move. */
    let last: ScanPoint | null = null;
    const feed = (point: ScanPoint, shift: boolean) => {
      if (shift) scanner.scan(point);
      else scanner.stop();
    };
    const native = getCurrentWebviewWindow().listen<NativePointer>("popover:pointer", (e) => {
      lastNative = performance.now();
      const { x, y, screenX, screenY, shift } = e.payload;
      feed({ x, y, screenX, screenY }, shift);
    });
    const onMouseMove = (e: MouseEvent) => {
      if (performance.now() - lastNative < NATIVE_GRACE_MS) return;
      const desktop = desktopPointOf(e);
      last = { x: e.clientX, y: e.clientY, screenX: desktop.x, screenY: desktop.y };
      feed(last, e.shiftKey || desktopShift);
    };
    const desktop = listen<{ shift?: boolean }>("linux-dictionary-modifier", (e) => {
      desktopShift = !!e.payload?.shift;
      if (performance.now() - lastNative < NATIVE_GRACE_MS || !last) return;
      feed(last, desktopShift);
    });
    const onLeave = () => {
      last = null;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") scanner.stop();
    };
    // The word stays selected while its pop-up is open, and is let go with it.
    const hidden = listen<{ level?: number } | null>("popover:hide", (e) => {
      if ((e.payload?.level ?? 0) <= level + 1) scanner.clearSelection();
    });
    window.addEventListener("mousemove", onMouseMove);
    document.documentElement.addEventListener("mouseleave", onLeave);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      void native.then((stop) => stop());
      void hidden.then((stop) => stop());
      void desktop.then((stop) => stop());
      window.removeEventListener("mousemove", onMouseMove);
      document.documentElement.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("keyup", onKeyUp);
      scanner.stop();
    };
  }, [baseUrl, canNest, level]);
}

import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createScanner, type ScanPoint } from "@ui/scan-text";
import { buildAnkiConfigForPopover } from "@texthooker/lib/ankiConfig";
import { getSettings } from "@texthooker/lib/settings";

/** Scanning works on any text inside an element with this class — the lines
    container and the Explain modal both opt in. */
const SCAN_REGION_SELECTOR = ".scan-region";

/** The block that bounds a scan: reading forward (for the lookup window and
    the highlight range) never crosses this element's edge. `.line` rows in
    the main view; ordinary block elements in markdown content. */
const SCAN_BLOCK_SELECTOR =
  ".line, p, li, h1, h2, h3, h4, td, th, blockquote, pre";

/** Shift-hover lookups with the Yomitan API pop-up, in the Log and the Explain modal. */
export function useScanMode(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const scanner = createScanner({
      region: SCAN_REGION_SELECTOR,
      block: SCAN_BLOCK_SELECTOR,
      // .line rows carry the canonical text in a data attribute; for other
      // scan regions (e.g. the Explain modal) fall back to the block's text.
      sentenceOf: (node) =>
        node.parentElement?.closest<HTMLElement>(".line")?.dataset.lineText ??
        node.parentElement
          ?.closest(SCAN_BLOCK_SELECTOR)
          ?.textContent?.trim() ??
        null,
      tokenize: (text, scanLength) =>
        invoke("yomitan_tokenize", {
          baseUrl: getSettings().yomitanApiUrl,
          body: { text, scan_length: scanLength },
        }),
      show: ({ term, sentence, anchor, point }) => {
        const settings = getSettings();
        invoke("show_popover", {
          term,
          cursorX: point.screenX,
          cursorY: point.screenY,
          anchor,
          width: settings.popoverWidth,
          height: settings.popoverHeight,
          baseUrl: settings.yomitanApiUrl,
          focus: false,
          sentence,
          includeMedia: settings.audioEnabled || settings.ankiEnabled,
          audioAutoplay: settings.audioEnabled && settings.audioAutoplay,
          audioVolume: settings.audioVolume,
          ankiConfig: buildAnkiConfigForPopover(settings),
        }).catch((err) => console.warn("[scan] show_popover failed", err));
      },
    });

    let shift = false;
    /** The pointer's last position, kept while Shift is up too, so pressing
        Shift over a word scans it without the mouse having to move. */
    let pointer: ScanPoint | null = null;
    /** The visible pop-ups, in desktop points (`popover:cards`). This window keeps the
        keyboard, so it keeps getting the pointer's moves while the pointer is over a pop-up:
        those belong to the pop-up, not to the line it covers. */
    let cards: { x: number; y: number; width: number; height: number }[] = [];
    const overPopup = (p: ScanPoint) =>
      cards.some(
        (c) =>
          p.screenX >= c.x &&
          p.screenX < c.x + c.width &&
          p.screenY >= c.y &&
          p.screenY < c.y + c.height,
      );
    const scan = (p: ScanPoint) => {
      if (overPopup(p)) scanner.stop();
      else scanner.scan(p);
    };

    const setShift = (down: boolean) => {
      if (down === shift) return;
      shift = down;
      document.body.classList.toggle("scan-mode", down);
      if (down) {
        if (pointer) scan(pointer);
      } else scanner.stop();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShift(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShift(false);
    };
    const onBlur = () => setShift(false);
    const onMouseMove = (e: MouseEvent) => {
      pointer = {
        x: e.clientX,
        y: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
      };
      // event.shiftKey is the source of truth: keydown can be missed when the
      // window doesn't have focus, but mousemove carries the modifier state.
      if (e.shiftKey !== shift) setShift(e.shiftKey);
      else if (shift) scan(pointer);
    };
    // Only the first pop-up is this word's; the ones nested on it close on their own.
    const stopClearing = listen<{ level?: number } | null>("popover:hide", (e) => {
      if (!e.payload?.level) scanner.clearSelection();
    });

    const stopCards = listen<typeof cards>("popover:cards", (e) => {
      cards = Array.isArray(e.payload) ? e.payload : [];
    });

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("mousemove", onMouseMove);
    return () => {
      void stopClearing.then((stop) => stop());
      void stopCards.then((stop) => stop());
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mousemove", onMouseMove);
      document.body.classList.remove("scan-mode");
      scanner.stop();
    };
  }, [enabled]);
}

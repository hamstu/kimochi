import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { buildAnkiConfigForPopover } from "@texthooker/lib/ankiConfig";
import { getSettings } from "@texthooker/lib/settings";
import { scanFromWindow } from "@texthooker/lib/yomitan";

/** Scanning works on any text inside an element with this class — the lines
    container and the Explain modal both opt in. */
const SCAN_REGION_SELECTOR = ".scan-region";

/** The block that bounds a scan: reading forward (for the lookup window and
    the highlight range) never crosses this element's edge. `.line` rows in
    the main view; ordinary block elements in markdown content. */
const SCAN_BLOCK_SELECTOR =
  ".line, p, li, h1, h2, h3, h4, td, th, blockquote, pre";

const SCAN_WINDOW = 16;
const THROTTLE_MS = 25;
/** How long the cursor must rest on a new term before we fire the popover
    lookup. Short: a lookup takes tens of milliseconds and a newer one
    supersedes it, so this only skips the words a fast glide crosses. */
const POPOVER_DWELL_MS = 40;

interface CaretHit {
  node: Text;
  offset: number;
}

/**
 * Get the text node + offset of the glyph whose horizontal extent contains the
 * cursor x. Uses the browser's caret API to find a nearby text node, then walks
 * neighboring glyphs and tests their actual rects with a horizontal-only
 * check (line height makes vertical hit-testing unreliable).
 */
function caretFromPoint(x: number, y: number): CaretHit | null {
  type CaretFn = (
    x: number,
    y: number,
  ) => { offsetNode: Node; offset: number } | null;
  const cp = (document as Document & { caretPositionFromPoint?: CaretFn })
    .caretPositionFromPoint;

  let node: Text | null = null;
  let caretOffset = 0;

  if (typeof cp === "function") {
    const pos = cp.call(document, x, y);
    if (pos && pos.offsetNode && pos.offsetNode.nodeType === Node.TEXT_NODE) {
      node = pos.offsetNode as Text;
      caretOffset = pos.offset;
    }
  } else {
    const r = document.caretRangeFromPoint?.(x, y);
    if (r && r.startContainer && r.startContainer.nodeType === Node.TEXT_NODE) {
      node = r.startContainer as Text;
      caretOffset = r.startOffset;
    }
  }
  if (!node) return null;

  // Test the rect of a single glyph: is the cursor x strictly between its
  // left edge (inclusive) and right edge (exclusive)? Vertical hit isn't
  // checked because line-height inflates the box.
  const glyphContainsX = (n: Text, i: number): boolean => {
    if (i < 0 || i + 1 > n.data.length) return false;
    const r = document.createRange();
    try {
      r.setStart(n, i);
      r.setEnd(n, i + 1);
    } catch {
      return false;
    }
    // Some glyphs (e.g. ruby-influenced) produce multiple client rects; pick
    // the one whose vertical range covers the cursor y, else just the first.
    const rects = r.getClientRects();
    for (const rect of rects) {
      if (rect.width === 0) continue;
      if (y >= rect.top && y <= rect.bottom) {
        return x >= rect.left && x < rect.right;
      }
    }
    return false;
  };

  // Search outward from the caret offset for the glyph whose box contains x.
  // We look in (caret-1, caret, caret-2, caret+1, ...) order so the most likely
  // hit (just before or just at the caret) is tested first.
  const max = node.data.length;
  for (let d = 0; d <= 4; d++) {
    const left = caretOffset - 1 - d; // glyph ENDING at caret-d
    if (glyphContainsX(node, left)) return { node, offset: left };
    if (d > 0) {
      const right = caretOffset - 1 + d; // glyph starting at caret+d
      if (right + 1 <= max && glyphContainsX(node, right)) {
        return { node, offset: right };
      }
    }
  }

  // No glyph in this node — return null so the caller skips this tick.
  return null;
}

/**
 * Build a scan window of `len` characters starting at (node, offset), reading
 * forward across sibling text nodes within the same `.line` element. This lets
 * us cross token-span boundaries so 「走っている」 still scans correctly even
 * when those characters are split across multiple <button> wrappers.
 */
function readForwardText(start: Text, offset: number, len: number): string {
  let out = start.data.slice(offset);
  if (out.length >= len) return out.slice(0, len);

  const line = start.parentElement?.closest?.(SCAN_BLOCK_SELECTOR);
  if (!line) return out.slice(0, len);

  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let passedStart = false;
  let n: Node | null = walker.nextNode();
  while (n) {
    // Skip ruby annotations — their text is the reading, not part of the word.
    if ((n.parentElement?.nodeName ?? "") === "RT") {
      n = walker.nextNode();
      continue;
    }
    if (n === start) {
      passedStart = true;
    } else if (passedStart) {
      out += (n as Text).data;
      if (out.length >= len) break;
    }
    n = walker.nextNode();
  }
  return out.slice(0, len);
}

/**
 * Build a DOM Range that covers exactly `len` characters of base text starting
 * at (start, offset), walking forward across text nodes (skipping <rt> ruby
 * annotations). Returns null if we can't cover the full length.
 */
function buildForwardRange(
  start: Text,
  offset: number,
  len: number,
): Range | null {
  const range = document.createRange();
  range.setStart(start, offset);

  const line = start.parentElement?.closest?.(SCAN_BLOCK_SELECTOR);
  if (!line) return null;

  let remaining = len;
  const firstChunk = Math.min(start.data.length - offset, remaining);
  if (firstChunk >= remaining) {
    range.setEnd(start, offset + remaining);
    return range;
  }
  remaining -= firstChunk;
  range.setEnd(start, offset + firstChunk);

  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  let passedStart = false;
  let n: Node | null = walker.nextNode();
  while (n) {
    if ((n.parentElement?.nodeName ?? "") === "RT") {
      n = walker.nextNode();
      continue;
    }
    if (n === start) {
      passedStart = true;
    } else if (passedStart) {
      const t = n as Text;
      const take = Math.min(t.data.length, remaining);
      if (take >= remaining) {
        range.setEnd(t, take);
        return range;
      }
      range.setEnd(t, take);
      remaining -= take;
    }
    n = walker.nextNode();
  }
  return null; // couldn't cover full length
}

/* Highlight: overlay one or more absolutely-positioned div boxes over the
   matched range's client rects. Avoids mutating React-controlled DOM. */

let highlightOverlay: HTMLDivElement | null = null;

function ensureOverlay(): HTMLDivElement {
  if (highlightOverlay) return highlightOverlay;
  const layer = document.createElement("div");
  layer.id = "scan-highlight-layer";
  // z-index above the Explain dialog (z-50) so highlights stay visible when
  // scanning inside modals. pointer-events:none keeps it inert.
  layer.style.cssText =
    "position:fixed;inset:0;pointer-events:none;z-index:9999;";
  document.body.appendChild(layer);
  highlightOverlay = layer;
  return layer;
}

function clearScanHighlight() {
  if (highlightOverlay) {
    highlightOverlay.innerHTML = "";
  }
}

function setScanHighlight(range: Range | null) {
  if (!range) {
    clearScanHighlight();
    return;
  }
  const layer = ensureOverlay();
  layer.innerHTML = "";
  try {
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (r.width === 0 || r.height === 0) continue;
      const box = document.createElement("div");
      box.className = "scan-highlight-box";
      box.style.cssText = `
        position:fixed;
        left:${r.left}px;
        top:${r.top}px;
        width:${r.width}px;
        height:${r.height}px;
      `;
      layer.appendChild(box);
    }
  } catch (err) {
    console.warn("[scan] highlight rects failed", err);
  }
}

/** The matched word's box in desktop coordinates, which `show_popover` places the popup against. */
function screenAnchor(
  range: Range | null,
  ev: { x: number; y: number; screenX: number; screenY: number },
) {
  if (!range) return null;
  const r = range.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  // screen − client is where this document's viewport sits on the desktop.
  return {
    x: r.left + ev.screenX - ev.x,
    y: r.top + ev.screenY - ev.y,
    width: r.width,
    height: r.height,
  };
}

export function useScanMode(enabled = true) {
  const shiftDown = useRef(false);
  /** The term and position of the popup last shown, so resting on it doesn't reopen it. */
  const lastShown = useRef<string | null>(null);
  const lastTickAt = useRef(0);
  /** The pointer's last position, kept while Shift is up too, so pressing Shift over a word
      scans it without the mouse having to move. */
  const lastEvent = useRef<{
    x: number;
    y: number;
    screenX: number;
    screenY: number;
  } | null>(null);
  const pendingTick = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Single-flight gate: only one scan request in the air at a time. If the
  // mouse keeps moving while one is pending, we remember to run once more with
  // the latest position instead of stacking concurrent requests.
  const tickInFlight = useRef(false);
  const tickRerunQueued = useRef(false);
  // Dwell gate for the popover lookup (see POPOVER_DWELL_MS).
  const pendingPopover = useRef<{
    key: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const clearPendingPopover = () => {
      if (pendingPopover.current) {
        clearTimeout(pendingPopover.current.timer);
        pendingPopover.current = null;
      }
    };

    const enterScan = () => {
      if (shiftDown.current) return;
      shiftDown.current = true;
      document.body.classList.add("scan-mode");
    };

    const exitScan = () => {
      if (!shiftDown.current) return;
      shiftDown.current = false;
      document.body.classList.remove("scan-mode");
      lastShown.current = null;
      tickRerunQueued.current = false;
      clearPendingPopover();
      setScanHighlight(null);
      if (pendingTick.current) {
        clearTimeout(pendingTick.current);
        pendingTick.current = null;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Shift" || shiftDown.current) return;
      enterScan();
      // Scan where the pointer already is.
      if (lastEvent.current) schedule();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") exitScan();
    };
    const onBlur = () => exitScan();

    async function tick() {
      pendingTick.current = null;
      if (tickInFlight.current) {
        // A scan request is already in the air — run once more with the
        // latest position when it lands, rather than stacking requests.
        tickRerunQueued.current = true;
        return;
      }
      tickInFlight.current = true;
      try {
        await doTick();
      } finally {
        tickInFlight.current = false;
        if (tickRerunQueued.current) {
          tickRerunQueued.current = false;
          if (shiftDown.current) {
            lastTickAt.current = performance.now();
            void tick();
          }
        }
      }
    }

    async function doTick() {
      if (!shiftDown.current || !lastEvent.current) return;
      const ev = lastEvent.current;

      const hit = caretFromPoint(ev.x, ev.y);
      if (!hit || !hit.node.parentElement?.closest?.(SCAN_REGION_SELECTOR)) {
        return;
      }

      const windowText = readForwardText(hit.node, hit.offset, SCAN_WINDOW);
      if (!windowText) return;

      const settings = getSettings();
      const matched = await scanFromWindow(settings.yomitanApiUrl, windowText);
      if (!shiftDown.current) {
        // Shift was released while the request was in flight — drop the result.
        return;
      }
      if (!matched) {
        // No match here — clear any existing scan highlight and cancel any
        // not-yet-fired popover lookup (the cursor left that word).
        clearPendingPopover();
        setScanHighlight(null);
        return;
      }

      // Always refresh the highlight to follow the cursor, even if the matched
      // term is identical to the last one (the user may be hovering a different
      // occurrence of the same word).
      const range = buildForwardRange(hit.node, hit.offset, matched.length);
      setScanHighlight(range);
      const anchor = screenAnchor(range, ev);
      // The same word at the same place is the popup already showing; the same word elsewhere
      // (another occurrence) moves it.
      const key = `${matched}@${Math.round(anchor?.x ?? ev.screenX)},${Math.round(anchor?.y ?? ev.screenY)}`;

      if (key === lastShown.current) {
        clearPendingPopover();
        return;
      }
      if (pendingPopover.current?.key === key) {
        // Lookup for this word is already scheduled; let the dwell timer run.
        return;
      }

      // New word under the cursor — (re)start the dwell timer. Only when the
      // cursor rests on it do we fire the popover lookup, so gliding across a
      // line doesn't launch one lookup per word crossed.
      clearPendingPopover();
      const lineEl = hit.node.parentElement?.closest?.(
        ".line",
      ) as HTMLElement | null;
      const blockEl = hit.node.parentElement?.closest?.(
        SCAN_BLOCK_SELECTOR,
      ) as HTMLElement | null;
      // .line rows carry the canonical text in a data attribute; for other
      // scan regions (e.g. the Explain modal) fall back to the block's text.
      const sentenceForPopover =
        (lineEl?.dataset?.lineText as string | undefined) ??
        blockEl?.textContent?.trim() ??
        null;
      const timer = setTimeout(() => {
        pendingPopover.current = null;
        if (!shiftDown.current) return;
        lastShown.current = key;
        invoke("show_popover", {
          term: matched,
          cursorX: ev.screenX,
          cursorY: ev.screenY,
          anchor,
          width: settings.popoverWidth,
          height: settings.popoverHeight,
          baseUrl: settings.yomitanApiUrl,
          focus: false,
          sentence: sentenceForPopover,
          includeMedia: settings.audioEnabled || settings.ankiEnabled,
          audioAutoplay: settings.audioEnabled && settings.audioAutoplay,
          audioVolume: settings.audioVolume,
          ankiConfig: buildAnkiConfigForPopover(settings),
        }).catch((err) => console.warn("[scan] show_popover failed", err));
      }, POPOVER_DWELL_MS);
      pendingPopover.current = { key, timer };
    }

    function schedule() {
      const now = performance.now();
      const since = now - lastTickAt.current;
      if (since >= THROTTLE_MS) {
        lastTickAt.current = now;
        void tick();
      } else if (!pendingTick.current) {
        pendingTick.current = setTimeout(() => {
          lastTickAt.current = performance.now();
          void tick();
        }, THROTTLE_MS - since);
      }
    }

    const onMouseMove = (e: MouseEvent) => {
      lastEvent.current = {
        x: e.clientX,
        y: e.clientY,
        screenX: e.screenX,
        screenY: e.screenY,
      };
      // Use event.shiftKey as the source of truth — keydown can be missed
      // when the window doesn't have focus, but mousemove always carries
      // the current modifier state.
      if (e.shiftKey) enterScan();
      else exitScan();
      if (shiftDown.current) schedule();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    window.addEventListener("mousemove", onMouseMove);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("mousemove", onMouseMove);
      document.body.classList.remove("scan-mode");
      if (pendingTick.current) {
        clearTimeout(pendingTick.current);
      }
      clearPendingPopover();
    };
  }, [enabled]);
}

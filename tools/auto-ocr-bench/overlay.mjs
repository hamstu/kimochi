// Overlay state from DevTools, in physical screen pixels, and matching against the fake game's truth.
import * as l from "./lib.mjs";

export const OVERLAY = "overlay.html";

/** Every OCR box the overlay draws: text, screen rect, vertical flag, and computed visibility. */
export async function overlayBoxes() {
  return l.js(OVERLAY, `(() => {
    const dpr = window.devicePixelRatio;
    const ox = window.screenX, oy = window.screenY;
    return [...document.querySelectorAll('[data-ocr-word-box], .ocr-group')].map((el) => {
      const r = el.getBoundingClientRect();
      const cur = el.querySelector('.ocr-word-current') ?? el;
      const cs = getComputedStyle(el);
      const tr = cur.getBoundingClientRect();
      return {
        cls: el.className,
        text: cur.textContent,
        vertical: el.classList.contains('ocr-vertical'),
        textRect: [Math.round((ox + tr.left) * dpr), Math.round((oy + tr.top) * dpr), Math.round((ox + tr.right) * dpr), Math.round((oy + tr.bottom) * dpr)],
        rect: [Math.round((ox + r.left) * dpr), Math.round((oy + r.top) * dpr), Math.round((ox + r.right) * dpr), Math.round((oy + r.bottom) * dpr)],
        visible: cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0,
      };
    });
  })()`);
}

export async function overlayState() {
  return l.js(OVERLAY, `({
    visible: document.visibilityState, dpr: window.devicePixelRatio, screen: [window.screenX, window.screenY, innerWidth, innerHeight],
    words: document.querySelectorAll('[data-ocr-word-box]').length, skeletons: document.querySelectorAll('.ocr-skeleton').length,
    hoverChildren: document.getElementById('hover')?.childElementCount ?? null,
    selection: String(getSelection()),
  })`);
}

/** Waits until the overlay shows at least `min` boxes and no skeletons; returns them. */
export async function waitBoxes({ min = 1, timeout = 20000, predicate = () => true } = {}) {
  const t0 = Date.now();
  for (;;) {
    const boxes = await overlayBoxes().catch(() => []);
    const real = boxes.filter((b) => !b.cls.includes("skeleton"));
    if (real.length >= min && !boxes.some((b) => b.cls.includes("skeleton")) && predicate(real)) return { boxes: real, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeout) return { boxes: real, ms: null, timedOut: true };
    await l.sleep(150);
  }
}

const norm = (s) => s.replace(/\s+/g, "");

/**
 * Matches truth lines to overlay boxes by text (a box may hold a line or part of it) and
 * reports pixel error per line: edges of the box against the line's ink box.
 */
export function compare(truth, boxes) {
  const rows = [];
  for (const line of truth.lines) {
    const ink = line.glyphs.map((g) => g.ink).filter(Boolean);
    if (!ink.length) continue;
    const inkBox = l.union(ink);
    // Boxes whose text is part of this line and overlap it.
    const mine = boxes.filter((b) => {
      // Mostly inside the line's ink box (text may differ: OCR misreads count as a found line).
      const r = b.textRect ?? b.rect;
      const ix = Math.max(0, Math.min(r[2], inkBox[2]) - Math.max(r[0], inkBox[0]));
      const iy = Math.max(0, Math.min(r[3], inkBox[3]) - Math.max(r[1], inkBox[1]));
      return norm(b.text) && ix * iy > 0.4 * (r[2] - r[0]) * (r[3] - r[1]);
    });
    if (!mine.length) {
      rows.push({ id: line.id, text: line.text, found: false });
      continue;
    }
    const box = l.union(mine.map((b) => b.rect));
    const tbox = l.union(mine.map((b) => b.textRect ?? b.rect));
    const text = mine.map((b) => b.text).join("");
    rows.push({
      id: line.id, text: line.text, found: true, ocr: text, exact: norm(text) === norm(line.text),
      vertical: line.vertical, ocrVertical: mine.some((b) => b.vertical),
      err: { left: box[0] - inkBox[0], top: box[1] - inkBox[1], right: box[2] - inkBox[2], bottom: box[3] - inkBox[3] },
      iou: +l.iou(box, inkBox).toFixed(3), boxes: mine.length,
      textErr: { left: tbox[0] - inkBox[0], top: tbox[1] - inkBox[1], right: tbox[2] - inkBox[2], bottom: tbox[3] - inkBox[3] },
      textIou: +l.iou(tbox, inkBox).toFixed(3),
      centerErr: Math.round(Math.hypot((tbox[0] + tbox[2] - inkBox[0] - inkBox[2]) / 2, (tbox[1] + tbox[3] - inkBox[1] - inkBox[3]) / 2)),
    });
  }
  const extra = boxes.filter((b) => !rows.some((r) => r.found && r.ocr?.includes(b.text)));
  return { rows, extra: extra.map((b) => ({ text: b.text, rect: b.rect, vertical: b.vertical })) };
}

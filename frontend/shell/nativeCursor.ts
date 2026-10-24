/**
 * Resolve the CSS cursor seen by the inactive-window hover bridge to the
 * explicit AppKit cursor it should keep installed.
 *
 * WebKit reports `auto` for ordinary transcript text even though its own
 * cursor resolution displays an I-beam. Passing that `auto` through to the
 * native bridge used to select the arrow every 50 ms, racing WebKit's I-beam.
 */
export function resolveNativeCursor(
  cssCursor: string,
  disabled: boolean,
  transcriptText: boolean,
): string {
  if (disabled) return "default";
  if (cssCursor === "auto" && transcriptText) return "text";
  return cssCursor;
}

/**
 * Whether a viewport point is over rendered text glyphs, not just inside a text element's box.
 *
 * WebKit shows the I-beam only over the text itself; over a line's padding, the empty space to
 * the right of a short line, or the gap between lines it shows the arrow. The bridge must make
 * the same call, or it keeps reasserting an I-beam that WebKit immediately replaces, and the
 * cursor flickers between the two.
 */
export function isPointOverText(x: number, y: number, doc: Document = document): boolean {
  const range = doc.caretRangeFromPoint?.(x, y);
  const node = range?.startContainer;
  if (!node || node.nodeType !== 3 /* TEXT_NODE */ || !node.textContent?.trim()) return false;
  const probe = doc.createRange();
  probe.selectNodeContents(node);
  for (const rect of probe.getClientRects()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}

const CONTROLS = 'button, [role="button"], input, select, textarea, a';
/** `<input>` types WebKit draws as a text field, and so gives an I-beam under `cursor: auto`. */
const TEXT_INPUTS = new Set([
  "", "text", "search", "email", "url", "tel", "password", "number",
  "date", "datetime-local", "month", "time", "week",
]);

/**
 * What `cursor: auto` resolves to on a control, the way WebKit resolves it: an I-beam in a text
 * field or an editable region, a hand on a link, otherwise the arrow. A page's own `<input>`
 * computes to `auto`, so passing that through would show the arrow over every text field.
 */
function autoCursorFor(control: Element | null, target: Element): string | null {
  if ((target as HTMLElement).isContentEditable === true) return "text";
  if (!control) return null;
  const tag = control.tagName;
  if (tag === "TEXTAREA") return "text";
  if (tag === "INPUT") {
    const type = (control.getAttribute("type") ?? "").toLowerCase();
    return TEXT_INPUTS.has(type) ? "text" : "default";
  }
  if (tag === "A" && control.hasAttribute("href")) return "pointer";
  return "default";
}

/**
 * The cursor keyword for a viewport point of `doc`, by the bridge's rules, or null when nothing is
 * there. An iframe resolves to null: only the frame's own document knows its cursor (see
 * `probeFrameCursor`).
 */
export function nativeCursorAt(doc: Document, x: number, y: number): string | null {
  const target = doc.elementFromPoint(x, y);
  if (!target || target.tagName === "IFRAME") return null;
  const control = target.closest(CONTROLS);
  const disabled = control !== null && control.hasAttribute("disabled");
  // `auto` means an I-beam only over actual selectable text, which is WebKit's own rule: over a
  // line's padding, the empty space beside it or any unselectable chrome WebKit shows the arrow,
  // and so must the bridge.
  const style = (doc.defaultView ?? window).getComputedStyle(target);
  if (style.cursor === "auto" && !disabled) {
    const resolved = autoCursorFor(control, target);
    if (resolved) return resolved;
  }
  const selectable = (style.webkitUserSelect || style.userSelect) !== "none";
  const transcriptText = control === null && selectable && isPointOverText(x, y, doc);
  return resolveNativeCursor(style.cursor, disabled, transcriptText);
}

/** The window message a panel posts into a hosted iframe to ask for the cursor at a point. */
export const CURSOR_PROBE = "kimochi:cursor-probe";
/** The hosted frame's answer, posted back to its parent. */
export const CURSOR_REPLY = "kimochi:cursor";
/** How long a panel waits for that answer; silence means the arrow. */
export const FRAME_PROBE_TIMEOUT_MS = 40;
const KEYWORD = /^[a-z-]{1,32}$/;

let nextProbe = 1;

/**
 * Ask a hosted iframe (an engine's settings page, which carries Kimochi's extension host and so
 * `installFrameCursorResponder`) for the cursor at a viewport point of the parent. Sent only to
 * the origin of the frame's `src`, accepted only from that frame's window and origin; anything
 * else, or no answer in time, resolves to `default`.
 */
export function probeFrameCursor(
  frame: HTMLIFrameElement,
  x: number,
  y: number,
  timeoutMs = FRAME_PROBE_TIMEOUT_MS,
): Promise<string> {
  const target = frame.contentWindow;
  const host = frame.ownerDocument.defaultView;
  let origin: string;
  try {
    origin = new URL(frame.src, frame.ownerDocument.baseURI).origin;
  } catch {
    return Promise.resolve("default");
  }
  if (!target || !host || origin === "null") return Promise.resolve("default");
  const rect = frame.getBoundingClientRect();
  const id = nextProbe++;
  return new Promise((resolve) => {
    const finish = (cursor: string): void => {
      clearTimeout(timer);
      host.removeEventListener("message", onMessage);
      resolve(cursor);
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== target || event.origin !== origin) return;
      const data = event.data as { type?: unknown; id?: unknown; cursor?: unknown } | null;
      if (data?.type !== CURSOR_REPLY || data.id !== id) return;
      finish(typeof data.cursor === "string" && KEYWORD.test(data.cursor) ? data.cursor : "default");
    };
    const timer = setTimeout(() => finish("default"), timeoutMs);
    host.addEventListener("message", onMessage);
    target.postMessage(
      {
        type: CURSOR_PROBE,
        id,
        x: x - rect.left - frame.clientLeft,
        y: y - rect.top - frame.clientTop,
      },
      origin,
    );
  });
}

/**
 * Answer `probeFrameCursor` in a framed document: from its parent window only, back to the
 * parent's origin only (the first of `location.ancestorOrigins` where the engine provides it).
 * Installed once per window; a top-level document never answers.
 */
export function installFrameCursorResponder(win: Window): boolean {
  const flagged = win as Window & { __kimochiCursorResponder?: boolean };
  if (win.parent === win || flagged.__kimochiCursorResponder) return false;
  flagged.__kimochiCursorResponder = true;
  win.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== win.parent) return;
    const data = event.data as { type?: unknown; id?: unknown; x?: unknown; y?: unknown } | null;
    if (data?.type !== CURSOR_PROBE || typeof data.id !== "number") return;
    if (typeof data.x !== "number" || typeof data.y !== "number") return;
    if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
    const parentOrigin = win.location.ancestorOrigins?.[0];
    if (parentOrigin && parentOrigin !== event.origin) return;
    let cursor = "default";
    try {
      cursor = nativeCursorAt(win.document, data.x, data.y) ?? "default";
    } catch {
      // A document mid-navigation: the arrow.
    }
    win.parent.postMessage({ type: CURSOR_REPLY, id: data.id, cursor }, event.origin);
  });
  return true;
}

/** A real `mousemove` this recent means WebKit is still tracking the pointer itself. */
export const WEBVIEW_MOVE_FRESH_MS = 150;
/** Polls in a row that must see the pointer move with no real `mousemove` before the bridge takes over. */
export const UNTRACKED_POLLS_TO_TAKE_OVER = 2;

/**
 * Who sets the cursor over this window: the webview itself, or the native bridge.
 *
 * Whenever the webview receives real mouse events (the key window, Windows and Linux always) it
 * sets the cursor on every move from its own hit test: an I-beam over an input, a hand over a
 * link. The bridge's 50 ms `panel_cursor` can never match that call exactly (an `<input>` computes
 * to `auto`, an iframe hides its content), so reasserting its own guess there made the two
 * alternate between arrow, hand and I-beam several times a second. The bridge exists only for the
 * case the webview sees no events at all (a WKWebView in an inactive window, WebKit 187545), so it
 * stays silent while real events arrive and takes over only once the native pointer has moved on
 * two polls in a row without one.
 */
export class CursorOwnership {
  private lastRealMove = Number.NEGATIVE_INFINITY;
  private lastPoint: string | null = null;
  private untrackedPolls = UNTRACKED_POLLS_TO_TAKE_OVER;

  /** A real (trusted) `mousemove` reached the page: the webview owns the cursor. */
  realMove(now: number): void {
    this.lastRealMove = now;
    this.untrackedPolls = 0;
  }

  /** One bridge poll with the native pointer in window coordinates, or null when it is elsewhere. */
  poll(point: readonly [number, number] | null, now: number): void {
    const key = point ? `${Math.round(point[0])},${Math.round(point[1])}` : null;
    const moved = key !== this.lastPoint;
    this.lastPoint = key;
    // A pointer at rest proves nothing either way: keep whoever owned it.
    if (!moved || key === null) return;
    if (now - this.lastRealMove <= WEBVIEW_MOVE_FRESH_MS) this.untrackedPolls = 0;
    else this.untrackedPolls += 1;
  }

  /** Whether the bridge should set the native cursor on this poll. */
  bridgeOwnsCursor(): boolean {
    return this.untrackedPolls >= UNTRACKED_POLLS_TO_TAKE_OVER;
  }
}

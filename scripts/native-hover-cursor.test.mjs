import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const [{ text: moduleSource }] = await build({
  entryPoints: ["frontend/shell/nativeCursor.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
}).then((result) => result.outputFiles);

const { CursorOwnership, resolveNativeCursor } = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`
);

test("ordinary transcript text resolves WebKit auto to a stable native I-beam", () => {
  for (let poll = 0; poll < 100; poll += 1) {
    assert.equal(resolveNativeCursor("auto", false, true), "text");
  }
});

test("explicit controls and non-transcript surfaces keep their cursor decisions", () => {
  assert.equal(resolveNativeCursor("pointer", false, true), "pointer");
  assert.equal(resolveNativeCursor("crosshair", false, true), "crosshair");
  assert.equal(resolveNativeCursor("auto", false, false), "auto");
  assert.equal(resolveNativeCursor("pointer", true, true), "default");
});

test("auto on a nested transcript control remains an arrow decision", () => {
  // useNativeHover classifies controls as non-text before calling this seam.
  assert.equal(resolveNativeCursor("auto", false, false), "auto");
});

// The bridge's 50 ms NSCursor writes used to race WebKit's own cursor in the key window (an
// <input> computes to `auto`, so the bridge set the arrow while WebKit set the I-beam): the
// cursor flickered. The bridge now only writes while the webview sees no real mouse events.
test("the bridge stays silent while the webview receives real mouse moves", () => {
  const own = new CursorOwnership();
  let now = 0;
  own.realMove(now);
  for (let poll = 0; poll < 100; poll += 1) {
    now += 50;
    own.realMove(now - 10);
    own.poll([100 + poll, 40], now);
    assert.equal(own.bridgeOwnsCursor(), false);
  }
});

test("a pointer at rest after real moves keeps the webview's cursor", () => {
  const own = new CursorOwnership();
  own.realMove(0);
  own.poll([10, 10], 20);
  for (let now = 70; now < 5000; now += 50) {
    own.poll([10, 10], now);
    assert.equal(own.bridgeOwnsCursor(), false);
  }
});

test("the bridge takes over when the pointer moves with no real events (inactive window)", () => {
  const own = new CursorOwnership();
  own.realMove(0);
  own.poll([10, 10], 20);
  // One move without an event may just be the event still in flight: no takeover yet.
  own.poll([30, 10], 1000);
  assert.equal(own.bridgeOwnsCursor(), false);
  own.poll([50, 10], 1050);
  assert.equal(own.bridgeOwnsCursor(), true);
  // Resting there keeps the bridge in charge, and a real move hands the cursor back at once.
  own.poll([50, 10], 1100);
  assert.equal(own.bridgeOwnsCursor(), true);
  own.realMove(1120);
  assert.equal(own.bridgeOwnsCursor(), false);
});

test("before any real move the bridge owns the cursor, as in a window that never had focus", () => {
  const own = new CursorOwnership();
  own.poll([5, 5], 0);
  assert.equal(own.bridgeOwnsCursor(), true);
  own.poll(null, 50);
  own.poll([5, 5], 100);
  assert.equal(own.bridgeOwnsCursor(), true);
});

// --- Cursors inside hosted iframes (an engine's settings page in the Dictionary window). ---

const {
  nativeCursorAt,
  probeFrameCursor,
  installFrameCursorResponder,
  CURSOR_PROBE,
  CURSOR_REPLY,
} = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString("base64")}`);

/** A fake element: `control` is what `closest(...)` finds (itself by default). */
function element(tagName, { attrs = {}, control, editable = false } = {}) {
  const el = {
    tagName,
    isContentEditable: editable,
    hasAttribute: (name) => name in attrs,
    getAttribute: (name) => attrs[name] ?? null,
  };
  el.closest = () => (control === undefined ? el : control);
  return el;
}

/** A fake document whose single element at every point has this computed style. */
function documentWith(target, style = {}) {
  return {
    elementFromPoint: () => target,
    defaultView: {
      getComputedStyle: () => ({ cursor: "auto", userSelect: "auto", webkitUserSelect: "", ...style }),
    },
  };
}

test("an engine page's controls resolve `auto` the way WebKit draws them", () => {
  const at = (target, style) => nativeCursorAt(documentWith(target, style), 1, 1);
  assert.equal(at(element("INPUT")), "text");
  assert.equal(at(element("INPUT", { attrs: { type: "url" } })), "text");
  assert.equal(at(element("TEXTAREA")), "text");
  assert.equal(at(element("INPUT", { attrs: { type: "checkbox" } })), "default");
  assert.equal(at(element("A", { attrs: { href: "#" } })), "pointer");
  assert.equal(at(element("BUTTON")), "default");
  assert.equal(at(element("DIV", { control: null, editable: true })), "text");
  assert.equal(at(element("INPUT", { attrs: { disabled: "" } })), "default");
  assert.equal(at(element("BUTTON"), { cursor: "pointer" }), "pointer");
  assert.equal(at(element("IFRAME")), null);
  assert.equal(at(null), null);
});

/** A parent window and a framed one, wired like real windows: messages carry source and origin. */
function framePair({ parentOrigin = "tauri://localhost", frameOrigin = "http://127.0.0.1:27631", ancestor } = {}) {
  const make = (origin) => {
    const win = { origin, listeners: new Set() };
    win.addEventListener = (type, fn) => type === "message" && win.listeners.add(fn);
    win.removeEventListener = (type, fn) => win.listeners.delete(fn);
    return win;
  };
  const parent = make(parentOrigin);
  const frame = make(frameOrigin);
  parent.parent = parent;
  frame.parent = parent;
  frame.location = { ancestorOrigins: [ancestor ?? parentOrigin] };
  const deliver = (to, from) => (data, targetOrigin) => {
    if (targetOrigin !== "*" && targetOrigin !== to.origin) return; // dropped, as a browser does
    setTimeout(() => {
      for (const fn of [...to.listeners]) fn({ data, source: from, origin: from.origin });
    }, 0);
  };
  frame.postMessage = deliver(frame, parent);
  parent.postMessage = deliver(parent, frame);
  const iframe = {
    src: `${frameOrigin}/settings.html`,
    contentWindow: frame,
    ownerDocument: { defaultView: parent, baseURI: `${parentOrigin}/app/panel.html` },
    clientLeft: 1,
    clientTop: 1,
    getBoundingClientRect: () => ({ left: 100, top: 40 }),
  };
  return { parent, frame, iframe };
}

test("a hosted frame answers the parent's probe at the frame-relative point", async () => {
  const { frame, iframe } = framePair();
  const seen = [];
  const input = element("INPUT");
  frame.document = {
    ...documentWith(input),
    elementFromPoint: (x, y) => {
      seen.push([x, y]);
      return input;
    },
  };
  assert.equal(installFrameCursorResponder(frame), true);
  assert.equal(installFrameCursorResponder(frame), false, "installed once per window");
  assert.equal(await probeFrameCursor(iframe, 150, 90), "text");
  assert.deepEqual(seen, [[49, 49]]);
});

test("no answer, or one from the wrong window or origin, means the arrow", async () => {
  // No responder in the frame at all (a page Kimochi does not host).
  const silent = framePair();
  assert.equal(await probeFrameCursor(silent.iframe, 150, 90, 20), "default");

  // The frame navigated to another origin: the probe is never delivered.
  const moved = framePair();
  moved.frame.document = documentWith(element("INPUT"));
  installFrameCursorResponder(moved.frame);
  moved.iframe.src = "https://example.com/";
  assert.equal(await probeFrameCursor(moved.iframe, 150, 90, 20), "default");

  // A reply that does not come from the frame's window is ignored.
  const forged = framePair();
  forged.frame.postMessage = (data) => {
    setTimeout(() => {
      for (const fn of [...forged.parent.listeners]) {
        fn({ data: { type: CURSOR_REPLY, id: data.id, cursor: "pointer" }, source: {}, origin: forged.frame.origin });
      }
    }, 0);
  };
  assert.equal(await probeFrameCursor(forged.iframe, 150, 90, 20), "default");

  // Junk in the reply is never handed to native.
  const junk = framePair();
  junk.frame.postMessage = (data) => {
    setTimeout(() => {
      for (const fn of [...junk.parent.listeners]) {
        fn({ data: { type: CURSOR_REPLY, id: data.id, cursor: "url(x), pointer" }, source: junk.frame, origin: junk.frame.origin });
      }
    }, 0);
  };
  assert.equal(await probeFrameCursor(junk.iframe, 150, 90, 20), "default");
});

test("the frame answers only its parent, at the parent's origin", async () => {
  const { frame, parent } = framePair({ ancestor: "https://evil.example" });
  frame.document = documentWith(element("INPUT"));
  installFrameCursorResponder(frame);
  const replies = [];
  parent.addEventListener("message", (event) => replies.push(event.data));
  // From the parent, but its origin is not the frame's real ancestor: no answer.
  frame.postMessage({ type: CURSOR_PROBE, id: 1, x: 1, y: 1 }, frame.origin);
  // Not from the parent at all: no answer.
  for (const fn of [...frame.listeners]) fn({ data: { type: CURSOR_PROBE, id: 2, x: 1, y: 1 }, source: {}, origin: parent.origin });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(replies, []);

  const top = framePair().parent;
  assert.equal(installFrameCursorResponder(top), false, "a top-level document never answers");
});

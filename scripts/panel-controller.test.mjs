import { test } from "node:test";
import assert from "node:assert/strict";
import {
  directionalTarget,
  snapshotEdges,
  installPanelController,
  changeNativeControl,
} from "../ui/panel-controller.js";
const rect = (x, y, width = 30, height = 20) => ({
  left: x,
  top: y,
  width,
  height,
  right: x + width,
  bottom: y + height,
});

test("navigation favors matching rows, rejects backwards candidates and preserves ties", () => {
  const sameRow = { id: "row", rect: rect(200, 0) };
  const diagonal = { id: "diagonal", rect: rect(40, 35) };
  assert.equal(
    directionalTarget([diagonal, sameRow], rect(0, 0), "right"),
    sameRow,
  );
  assert.equal(directionalTarget([sameRow], rect(0, 0), "left"), null);
  const tied = { id: "tie", rect: rect(200, 0) };
  assert.equal(
    directionalTarget([sameRow, tied], rect(0, 0), "right"),
    sameRow,
  );
});
test("vertical navigation selects appropriate column, negative coordinates work", () => {
  const target = { rect: rect(-120, -50) };
  assert.equal(directionalTarget([target], rect(-120, 0), "up"), target);
  assert.equal(directionalTarget([target], rect(-120, 0), "down"), null);
});
test("button edges include releases when device reports fewer buttons", () => {
  assert.deepEqual(snapshotEdges([true, false, true], [false, true]), {
    held: [1],
    pressed: [1],
    released: [0, 2],
  });
});

function harness() {
  const callbacks = new Map();
  let focused = true;
  let recording = false;
  let clicks = 0;
  let interval;
  let targets;
  let modal;
  const keys = [];
  const classes = new Set();
  const element = {
    tagName: "BUTTON",
    disabled: false,
    getBoundingClientRect: () => rect(0, 0),
    closest: () => null,
    getAttribute: () => null,
    matches: () => false,
    focus() {
      doc.activeElement = element;
    },
    scrollIntoView() {},
    click() {
      clicks++;
    },
    dispatchEvent(event) {
      keys.push(event.key);
    },
  };
  const doc = {
    activeElement: element,
    visibilityState: "visible",
    documentElement: {
      removeAttribute: (key) => classes.delete(key),
      setAttribute: (key) => classes.add(key),
    },
    hasFocus: () => focused,
    querySelector: () => (recording ? {} : null),
    querySelectorAll: (selector) =>
      selector.startsWith('[role="dialog"]')
        ? modal
          ? [modal]
          : []
        : selector === "iframe"
          ? []
          : (targets ?? [element]),
    addEventListener: (key, fn) => callbacks.set(key, fn),
    removeEventListener: (key) => callbacks.delete(key),
    dispatchEvent: () => true,
  };
  const win = {
    Event: class {
      constructor(type) {
        this.type = type;
      }
    },
    KeyboardEvent: class {
      constructor(type, options) {
        this.type = type;
        this.key = options.key;
      }
    },
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    dispatchEvent: () => true,
    document: doc,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }),
    addEventListener: (key, fn) => callbacks.set(key, fn),
    removeEventListener: (key) => callbacks.delete(key),
    setInterval: (fn) => {
      interval = fn;
      return 1;
    },
    clearInterval: () => {
      interval = null;
    },
  };
  doc.defaultView = win;
  element.ownerDocument = doc;
  const controller = installPanelController(win);
  const snapshot = (buttons, activeGamepadIndex = 0, extra = {}) =>
    controller.snapshot({
      buttonStates: buttons,
      activeGamepadIndex,
      axisStates: [0, 0, 0, 0],
      ...extra,
    });
  return {
    controller,
    snapshot,
    doc,
    element,
    keys,
    targets: (value) => {
      targets = value;
    },
    modal: (value) => {
      modal = value;
    },
    clicks: () => clicks,
    focused: (value) => {
      focused = value;
    },
    recording: (value) => {
      recording = value;
    },
    callbacks,
    interval: () => interval,
  };
}

test("focused panel confirms once and suppresses held buttons, recorders and device changes", () => {
  const h = harness();
  h.snapshot([]);
  h.snapshot([true]);
  h.snapshot([true]);
  assert.equal(h.clicks(), 1);
  h.focused(false);
  h.snapshot([]);
  h.snapshot([true]);
  h.focused(true);
  h.snapshot([true]);
  assert.equal(h.clicks(), 1, "held input does not activate after refocus");
  h.snapshot([]);
  h.recording(true);
  h.snapshot([true]);
  h.recording(false);
  h.snapshot([true]);
  assert.equal(h.clicks(), 1);
  h.snapshot([], 1);
  h.snapshot([true], 1);
  assert.equal(h.clicks(), 2);
  h.controller.destroy();
  assert.equal(h.interval(), null);
  assert.equal(h.callbacks.size, 0);
});
test("overlay menu chord does not also activate focused controls", () => {
  const h = harness();
  h.snapshot([]);
  const buttons = Array(12).fill(false);
  buttons[0] = true;
  buttons[10] = true;
  buttons[11] = true;
  h.snapshot(buttons);
  assert.equal(h.clicks(), 0);
  h.controller.destroy();
});

test("reset tolerates a document unloaded during an engine switch", () => {
  const h = harness();
  h.doc.documentElement = null;
  assert.doesNotThrow(() => h.callbacks.get("blur")());
  assert.doesNotThrow(() => h.callbacks.get("blur")());
  h.controller.destroy();
});

test("a focused panel ignores the pad while the overlay is reading, held buttons included", () => {
  // Opening the controller menu brings Kimochi to the front, so the Log can be the focused
  // window; its focused control (Quit, once) must not take the overlay's A.
  const h = harness();
  const reading = { overlayNavigation: true };
  h.snapshot([], 0, reading);
  h.snapshot([true], 0, reading);
  h.snapshot([], 0, reading);
  h.snapshot([true], 0, reading);
  assert.equal(h.clicks(), 0);
  // A still held as the overlay lets go is not a fresh press here.
  h.snapshot([true]);
  assert.equal(h.clicks(), 0);
  h.snapshot([]);
  h.snapshot([true]);
  assert.equal(h.clicks(), 1, "once the overlay is done, the panel works again");
  h.controller.destroy();
});

test("a control marked data-controller-skip is never focused or pressed", () => {
  const h = harness();
  h.element.closest = (selector) => (selector === "[data-controller-skip]" ? {} : null);
  h.doc.activeElement = null;
  h.snapshot([]);
  h.snapshot([true]);
  h.snapshot([]);
  h.snapshot([true]);
  assert.equal(h.clicks(), 0);
  assert.equal(h.doc.activeElement, null);
  h.controller.destroy();
});

test("missing focus seeds first control without accidentally activating it", () => {
  const h = harness();
  h.doc.activeElement = null;
  h.snapshot([]);
  h.snapshot([true]);
  assert.equal(h.doc.activeElement, h.element);
  assert.equal(h.clicks(), 0);
  h.snapshot([]);
  h.snapshot([true]);
  assert.equal(h.clicks(), 1);
  h.controller.destroy();
});

test("modal with tabindex=-1 scopes focus and B sends Escape before panel back", () => {
  const h = harness();
  const modal = {
    ...h.element,
    getAttribute: (key) =>
      key === "tabindex" ? "-1" : key === "role" ? "dialog" : null,
    querySelectorAll: () => [h.element],
    querySelector: () => null,
  };
  h.modal(modal);
  h.doc.activeElement = modal;
  h.snapshot([]);
  h.snapshot([true]);
  assert.equal(h.doc.activeElement, h.element);
  assert.equal(h.clicks(), 0);
  h.snapshot([]);
  h.snapshot([false, true]);
  assert.deepEqual(h.keys, ["Escape", "Escape"]);
  h.controller.destroy();
});

test("disabled and hidden controls cannot become initial controller focus", () => {
  const h = harness();
  h.targets([
    { ...h.element, disabled: true },
    { ...h.element, closest: () => ({ hidden: true }) },
    h.element,
  ]);
  h.doc.activeElement = null;
  h.snapshot([]);
  h.snapshot([true]);
  assert.equal(h.doc.activeElement, h.element);
  h.controller.destroy();
});

test("native select changes an enabled option and emits actual value events", () => {
  const events = [];
  const element = {
    tagName: "SELECT",
    selectedIndex: 0,
    options: [{}, { disabled: true }, {}],
    dispatchEvent: (event) => events.push(event.type),
    ownerDocument: {
      defaultView: {
        Event: class {
          constructor(type) {
            this.type = type;
          }
        },
      },
    },
  };
  changeNativeControl(element, "down");
  assert.equal(element.selectedIndex, 2);
  assert.deepEqual(events, ["input", "change"]);
  changeNativeControl(element, "down");
  assert.equal(events.length, 2, "boundary does not emit a false value change");
  changeNativeControl(element, "up");
  assert.equal(element.selectedIndex, 0);
});

test("native range obeys step and bounds through native setter with change events", () => {
  const events = [];
  class Input {
    get value() {
      return this._value;
    }
    set value(value) {
      this._value = value;
    }
  }
  const element = new Input();
  Object.assign(element, {
    type: "range",
    step: "5",
    min: "0",
    max: "10",
    value: "5",
    dispatchEvent: (event) => events.push(event.type),
    ownerDocument: {
      defaultView: {
        HTMLInputElement: Input,
        Event: class {
          constructor(type) {
            this.type = type;
          }
        },
      },
    },
  });
  changeNativeControl(element, "right");
  assert.equal(element.value, "10");
  changeNativeControl(element, "right");
  assert.deepEqual(events, ["input", "change"]);
  changeNativeControl(element, "left");
  assert.equal(element.value, "5");
});

test("tabindex=-1 menu options can seed focus and Yomitan B clicks existing Close", () => {
  const h = harness();
  h.element.getAttribute = (key) => (key === "tabindex" ? "-1" : null);
  h.element.matches = (selector) => selector.includes('[role="option"]');
  const modal = {
    ...h.element,
    querySelectorAll: () => [h.element],
    querySelector: () => h.element,
  };
  h.modal(modal);
  h.doc.activeElement = modal;
  h.snapshot([]);
  h.snapshot([true]);
  assert.equal(h.doc.activeElement, h.element);
  h.snapshot([]);
  h.snapshot([false, true]);
  assert.equal(h.clicks(), 1);
  assert.equal(h.keys.length, 0);
  h.controller.destroy();
});

test("configured radial chord reserves its buttons while unbound stick clicks do not suppress A", () => {
  const h = harness();
  h.controller.setMenuChord([0, 1]);
  h.snapshot([]);
  h.snapshot([true]);
  assert.equal(h.clicks(), 0);
  h.snapshot([true, true]);
  assert.equal(h.clicks(), 0);
  h.controller.setMenuChord([]);
  h.snapshot([]);
  const buttons = Array(12).fill(false);
  buttons[0] = true;
  buttons[10] = true;
  h.snapshot(buttons);
  assert.equal(h.clicks(), 1);
  h.controller.destroy();
});

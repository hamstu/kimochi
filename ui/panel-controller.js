/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Shared DOM adapter. */
import { openControllerKeyboard, supportsControllerKeyboard } from "./controller-keyboard.js";
import { ControllerInput } from "./controller-input.js";

const TARGETS =
  'button, a[href], input, select, textarea, iframe, summary, [data-modal-action], .settings-item-button, [tabindex], [role="button"], [role="tab"], [role="menuitem"], [role="option"]';
const ARROWS = {
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

/** Stable directional ranking; overlap wins over a nearby control in another row. */
export function directionalTarget(items, origin, direction) {
  const vertical = direction === "up" || direction === "down";
  const sign = direction === "up" || direction === "left" ? -1 : 1;
  const centre = (rect) => ({
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  });
  const start = centre(origin);
  let best = null;
  let score = Infinity;
  for (const item of items) {
    const rect = item.rect;
    const end = centre(rect);
    const primary = (vertical ? end.y - start.y : end.x - start.x) * sign;
    if (primary <= 1) continue;
    const secondary = Math.abs(vertical ? end.x - start.x : end.y - start.y);
    const overlap = vertical
      ? rect.right > origin.left && rect.left < origin.right
      : rect.bottom > origin.top && rect.top < origin.bottom;
    const rank = primary + secondary * 3 + (overlap ? 0 : 10000);
    if (rank < score) {
      best = item;
      score = rank;
    }
  }
  return best;
}

export function snapshotEdges(previous, next) {
  const held = [],
    pressed = [],
    released = [];
  for (let i = 0; i < Math.max(previous.length, next.length); ++i) {
    if (next[i]) held.push(i);
    if (next[i] && !previous[i]) pressed.push(i);
    if (!next[i] && previous[i]) released.push(i);
  }
  return { held, pressed, released };
}

/** DOM KeyboardEvents do not invoke browser defaults for native form controls. */
export function changeNativeControl(element, direction) {
  const delta = direction === "up" || direction === "right" ? 1 : -1;
  if (element.tagName === "SELECT") {
    const enabled = [...element.options]
      .map((option, index) => ({ option, index }))
      .filter(
        ({ option }) => !option.disabled && !option.parentElement?.disabled,
      );
    const position = enabled.findIndex(
      ({ index }) => index === element.selectedIndex,
    );
    // Select arrows follow conventional list order: down/right advances.
    const step = direction === "down" || direction === "right" ? 1 : -1;
    const next =
      enabled[Math.max(0, Math.min(enabled.length - 1, position + step))];
    if (!next || element.selectedIndex === next.index) return;
    element.selectedIndex = next.index;
  } else {
    const step =
      element.step && element.step !== "any" ? Number(element.step) : 1;
    const min =
      element.min === ""
        ? element.type === "range"
          ? 0
          : -Infinity
        : Number(element.min);
    const max =
      element.max === ""
        ? element.type === "range"
          ? 100
          : Infinity
        : Number(element.max);
    const value = Math.max(
      min,
      Math.min(max, (Number(element.value) || 0) + delta * step),
    );
    if (!Number.isFinite(value) || value === Number(element.value)) return;
    // Use the native setter so React's controlled-input tracker sees the input event.
    const setter = Object.getOwnPropertyDescriptor(
      element.ownerDocument.defaultView.HTMLInputElement.prototype,
      "value",
    )?.set;
    if (setter) setter.call(element, String(value));
    else element.value = String(value);
  }
  const Event = element.ownerDocument.defaultView.Event;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

/** One owner per focused panel; never enables overlay/global keyboard navigation.
 * @param {Window} win
 * @param {{onBack?: () => boolean}} options
 */
export function installPanelController(win, { onBack = () => false } = {}) {
  let previous = [];
  let previousPad = null;
  let scroll = 0;
  let editing = false;
  let menuChord = [10, 11];
  let keyboard = null;
  const documents = new Set([win.document]);
  const temporaryTabStops = new Set();
  const activeDocument = () => {
    let doc = win.document;
    while (doc.activeElement?.tagName === "IFRAME") {
      try {
        const child = doc.activeElement.contentDocument;
        if (!child) break;
        doc = child;
      } catch {
        break;
      }
    }
    documents.add(doc);
    return doc;
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
      !element.disabled &&
      element.getAttribute("aria-disabled") !== "true"
    );
  };
  const scope = (doc) => {
    const modals = [
      ...doc.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .modal:not([hidden])',
      ),
    ].filter(visible);
    return modals.at(-1) ?? doc;
  };
  const candidates = (doc) =>
    [...scope(doc).querySelectorAll(TARGETS)].filter(
      (element) =>
        visible(element) &&
        (element.getAttribute("tabindex") !== "-1" ||
          element.matches(
            '[role="option"], [role="menuitem"], [role="tab"], [role="radio"], [role="slider"]',
          )),
    );
  const key = (element, name) => {
    const Event = element.ownerDocument.defaultView.KeyboardEvent;
    element.dispatchEvent(
      new Event("keydown", { key: name, bubbles: true, cancelable: true }),
    );
    element.dispatchEvent(
      new Event("keyup", { key: name, bubbles: true, cancelable: true }),
    );
  };
  const focus = (element) => {
    if (element.tagName === "IFRAME") {
      try {
        const doc = element.contentDocument;
        const first = doc && candidates(doc)[0];
        if (first) {
          focus(first);
          return;
        }
      } catch {
        /* Cross-origin frame stays an ordinary focus target. */
      }
    }
    for (const doc of documents)
      doc.documentElement.removeAttribute("data-controller-focus");
    const doc = element.ownerDocument;
    documents.add(doc);
    if (
      doc !== win.document &&
      !doc.querySelector("[data-panel-controller-style]")
    ) {
      const style = doc.createElement("style");
      style.dataset.panelControllerStyle = "";
      style.textContent =
        "html[data-controller-focus] :focus { outline: 3px solid #78aaff !important; outline-offset: 2px !important; }";
      doc.head.append(style);
    }
    doc.documentElement.setAttribute("data-controller-focus", "");
    win.dispatchEvent(new win.Event("kimochi:controller-focus"));
    if (
      !element.hasAttribute?.("tabindex") &&
      element.matches("[data-modal-action], .settings-item-button")
    ) {
      element.setAttribute("tabindex", "0");
      temporaryTabStops.add(element);
    }
    element.focus({ preventScroll: true });
    element.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  const execute = (command) => {
    if (!eligible()) {
      reset();
      return;
    }
    const doc = activeDocument();
    let current = doc.activeElement;
    const controls = candidates(doc);
    if (command.type === "scroll") {
      scroll = command.y;
      return;
    }
    if (
      command.type === "aim" ||
      command.type === "menu" ||
      command.type === "step"
    )
      return;
    if (command.type === "cancel") {
      const popup = scope(doc);
      if (popup !== doc) {
        const close = popup.querySelector('[data-modal-action="hide"]');
        if (close && visible(close)) close.click();
        else key(current, "Escape");
        return;
      }
      if (editing) {
        editing = false;
        return;
      }
      const event = new win.CustomEvent("kimochi:controller-back", {
        bubbles: true,
        cancelable: true,
      });
      if (win.document.dispatchEvent(event) && !onBack()) reset();
      return;
    }
    if (!controls.includes(current)) {
      current = controls[0];
      if (current) focus(current);
      // A seed focus is not also an accidental activation.
      return;
    }
    if (command.type === "confirm") {
      if (supportsControllerKeyboard(current)) {
        keyboard?.close(false);
        keyboard = openControllerKeyboard(current, () => { keyboard = null; editing = false; });
        return;
      }

      if (
        current.matches(
          'input[data-controller-keyboard-input], textarea[data-controller-keyboard-input], input[type="range"], input[type="number"], select, [role="slider"]',
        )
      ) {
        editing = true;
        focus(current);
      } else if (current.matches('[role="option"], [role="menuitem"]'))
        key(current, "Enter");
      else current.click();
      return;
    }
    if (command.type === "dir") {
      if (
        editing &&
        current.matches('select, input[type="range"], input[type="number"]')
      ) {
        changeNativeControl(current, command.dir);
        return;
      }

      if (
        editing ||
        current.matches('[role="option"], [role="menuitem"]') ||
        scope(doc).getAttribute?.("role") === "listbox"
      ) {
        key(current, ARROWS[command.dir]);
        return;
      }
      const next = directionalTarget(
        controls
          .filter((element) => element !== current)
          .map((element) => ({
            element,
            rect: element.getBoundingClientRect(),
          })),
        current.getBoundingClientRect(),
        command.dir,
      );
      if (next) focus(next.element);
      else if (current.matches('[role="tab"]'))
        key(current, ARROWS[command.dir]);
    }
  };
  const input = new ControllerInput(execute);
  function eligible() {
    return (
      win.document.hasFocus() &&
      win.document.visibilityState !== "hidden" &&
      !activeDocument().querySelector("[data-recording], [data-capturing]")
    );
  }
  function reset() {
    input.reset();
    scroll = 0;
    editing = false;
    for (const doc of documents)
      doc.documentElement.removeAttribute("data-controller-focus");
  }
  const pointer = () => reset();
  win.addEventListener("blur", reset);
  win.document.addEventListener("pointerdown", pointer, true);
  // Frame events do not bubble to the parent document. Register once per loaded same-origin frame.
  const frameCleanups = [];
  const attachedFrames = new WeakSet();
  const attachFrames = () => {
    for (const frame of win.document.querySelectorAll("iframe")) {
      try {
        const doc = frame.contentDocument;
        if (!doc || attachedFrames.has(doc)) continue;
        attachedFrames.add(doc);
        documents.add(doc);
        doc.addEventListener("pointerdown", pointer, true);
        frameCleanups.push(() =>
          doc.removeEventListener("pointerdown", pointer, true),
        );
      } catch {
        /* Cross-origin frames retain their existing interaction. */
      }
    }
  };
  const timer = win.setInterval(() => {
    attachFrames();
    if (!eligible()) {
      reset();
      return;
    }
    if (Math.abs(scroll) < 0.2) return;
    let element = activeDocument().activeElement;
    while (element && element.scrollHeight <= element.clientHeight)
      element = element.parentElement;
    if (element) element.scrollTop -= scroll * 12;
  }, 32);
  return {
    setButtons(buttons) {
      input.setButtons(buttons);
    },
    setMenuChord(chord) {
      menuChord = Array.isArray(chord) ? chord.filter(Number.isInteger) : [];
      input.setMenuChord(menuChord);
      reset();
    },
    snapshot(payload) {
      const buttons = payload?.buttonStates ?? [];
      const pad = payload?.activeGamepadIndex ?? null;
      if (
        !eligible() ||
        pad === null ||
        pad !== previousPad ||
        menuChord.some((button) => buttons[button])
      ) {
        reset();
        previous = [...buttons];
        previousPad = pad;
        return;
      }
      const edges = snapshotEdges(previous, buttons);
      previous = [...buttons];
      const axes = payload.axisStates ?? [];
      input.nav({
        ...edges,
        stick: { x: axes[0] ?? 0, y: axes[1] ?? 0 },
        rstick: { x: axes[2] ?? 0, y: axes[3] ?? 0 },
      });
    },
    reset,
    destroy() {
      keyboard?.close(false);
      reset();
      win.clearInterval(timer);
      win.removeEventListener("blur", reset);
      win.document.removeEventListener("pointerdown", pointer, true);
      for (const cleanup of frameCleanups) cleanup();
      for (const element of temporaryTabStops)
        element.removeAttribute("tabindex");
      for (const doc of documents)
        doc.querySelector("[data-panel-controller-style]")?.remove();
    },
  };
}

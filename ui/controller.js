/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Controller mode: the radial menu, and stepping through the last scan word by word with the
 * dictionary popup following along.
 *
 * Opening it takes the game's focus away (native activates Kimochi, remembering which app was
 * in front) so the stick and buttons stop reaching the game, and every way out gives it back.
 * The overlay still never needs the keyboard itself: native reports controller input and the
 * arrow keys, Return and Escape as events for as long as the mode is open.
 *
 * Modes:  idle ── menu button ──▶ menu ── Read along ──▶ words
 *           ▲                       │                     │
 *           └──── B / Escape / an action / menu button ◀──┘
 */
import { ControllerInput } from "./controller-input.js";
import { RadialMenu, ICONS } from "./radial-menu.js";
import { WordCursor, segmentText, SCAN_LENGTH } from "./word-nav.js";
import { ControllerHistory } from "./controller-history.js";

/** Lets the menu's exit animation start before the chosen action changes the screen. */
const ACTION_DELAY_MS = 120;
/**
 * Right-stick popup scrolling, in points per second: a light push creeps, a full push races.
 * Native reports the stick from its 0.25 deadzone outwards; the speed rises with the square of
 * how far past it the stick is, so the slow end has room for fine control.
 */
const SCROLL_MIN = 70;
const SCROLL_MAX = 2400;
const SCROLL_DEADZONE = 0.25;

export function scrollSpeed(y) {
  const t = Math.min(
    1,
    Math.max(0, (Math.abs(y) - SCROLL_DEADZONE) / (1 - SCROLL_DEADZONE)),
  );
  if (Math.abs(y) < SCROLL_DEADZONE) return 0;
  return Math.sign(y) * (SCROLL_MIN + (SCROLL_MAX - SCROLL_MIN) * t * t);
}

/**
 * @param {object} context
 * @param {HTMLElement} context.host where the menu and the word cursor are drawn
 * @param {HTMLElement} context.words the text overlay's container, whose boxes hold the scan's text
 * @param {typeof import('./native.js')} context.native
 * @param {() => {hasText: boolean, autoOcr: boolean, autoAvailable: boolean, textVisible: boolean, center: {x: number, y: number}|null, area: {x: number, y: number, width: number, height: number}|null, origin: {x: number, y: number}|null}} context.status
 * @param {(id: 'auto') => void} context.run carries out a menu action
 * @param {() => Promise<boolean>} context.scan scan the source, resolving once its text is applied;
 *   true when the text drawn is current even if no new scan was applied (automatic OCR caught up)
 * @param {(control: {scroll?: number, step?: number}) => void} context.popupControl scroll the open
 *   popup by `scroll` points, or jump `step` definitions through it
 * @param {() => void} context.redraw redraw the text overlay (it is held visible in word mode)
 * @param {() => ((action: string, params: object) => Promise<any>)|null} context.dictionary Yomitan's backend API, once ready
 * @param {() => object} context.buttons the command buttons from settings (`controllerButtons`)
 * @param {() => string} context.popupType `builtin` (Yomitan) or `custom-api` (Kimochi pop-up)
 * @param {(range: Range) => Promise<boolean>} context.lookupRange open Yomitan's popup on a range
 * @param {(term: string, x: number, y: number, sentence: string) => Promise<void>} context.lookupTerm open the Kimochi pop-up
 * @param {() => void} context.dismiss close whichever popup is open
 * @param {(element: HTMLElement) => ({x: number, y: number, width: number, height: number, line: number}|null)[]|null} context.charRects
 *   where each character of a word-mode box is on the source, by code unit; null in grouped mode
 * @param {(quiet: boolean) => void} context.quietText hold the text overlay's boxes unlit
 * @param {(visible: boolean) => Promise<void>} context.setText the overlay's text switch, as the main window shows it
 * @param {(x: number, y: number) => boolean} context.nearText whether a point is on or close to scanned text
 * @param {(record: object) => void} context.log
 * @param {(mode: 'idle' | 'menu' | 'words' | 'history') => void} [context.modeChanged] the menu opened, word
 *   mode started, or controller mode ended; automatic OCR stands still while it is anything but idle
 * @param {() => Promise<object[]>} context.history read durable recent text without publishing it
 */
export function createController(context) {
  const { host, native } = context;
  let mode = "idle";
  function setMode(next) {
    if (next === mode) return;
    mode = next;
    context.modeChanged?.(next);
  }
  /** How the mode was opened, so the hints name the right buttons. */
  let input = "pad";
  let cursor = null;
  let highlight = null;
  let hud = null;
  /**
   * Set when leaving word mode turned the overlay's text off. It is the overlay's real text
   * switch, the one the main window shows, so the reader can turn it back on there; the next
   * scan turns it back on by itself, but only if this is what turned it off.
   */
  let hidText = false;
  /**
   * Who is reading in word mode: the controller, with the outline and its popup, or the mouse,
   * hovering and clicking the text as usual. Either takes over from the other just by being
   * used, so neither can lock the other out.
   */
  let driver = "controller";
  /** Where the pointer was when the controller took over, so a nudge is not taken as a takeover. */
  let pointerAnchor = null;
  /** How far the pointer must move, near the text, before the mouse takes over. */
  const MOUSE_TAKEOVER = 24;
  let lastPointer = null;
  let historical = false;
  const history = new ControllerHistory(host, {
    onRead: () => void readHistory(),
    onBack: () => void backToHistory(),
    onClose: () => void close(),
  });
  /** Right-stick scrolling: the stick's lean, and the frame loop applying it. */
  let scrollLean = 0;
  let scrollFrame = null;
  let scrollAt = 0;
  /** Bumped on every exit, so a segmentation that finishes late cannot reopen word mode. */
  let generation = 0;

  const menu = new RadialMenu(host, {
    onChoose: (id) => void choose(id),
    onClose: () => void close(),
  });
  const controls = new ControllerInput((command) => void handle(command));

  // The menu's own button combination closes it again, so it has to be known here.
  void native.hotkeysLoad?.().then((hotkeys) => {
    const binding = hotkeys?.openControllerMenu;
    const chord =
      binding?.gamepadButtons ??
      (Number.isInteger(binding?.gamepadButton) ? [binding.gamepadButton] : []);
    controls.setMenuChord(chord);
  });

  void native.listen("controller-nav", ({ payload }) => {
    if (mode === "idle") return;
    if (payload?.pressed?.length) input = "pad";
    controls.nav(payload);
  });
  // Native ended navigation because another app came to the front: its keys are already
  // given back, so just leave controller mode quietly.
  void native.listen("controller-nav-cancel", () => {
    context.log({ check: "controller-cancelled", reason: "focus-elsewhere" });
    void close();
  });
  void native.listen("controller-key", ({ payload }) => {
    if (mode === "idle") return;
    if (payload?.type === "keydown") input = "keys";
    controls.key(payload);
  });

  async function setNav(active) {
    try {
      await native.controllerNav(active);
    } catch (error) {
      context.log({
        check: "controller-nav-failed",
        active,
        error: String(error?.message ?? error),
      });
    }
  }

  function menuItems() {
    const status = context.status();
    return [
      { id: "scan", label: "Scan", icon: ICONS.scan, enabled: true },
      {
        id: "dictionary",
        label: "Read along",
        icon: ICONS.dictionary,
        enabled: status.hasText,
        lit: status.hasText,
        unavailable: "Scan first",
      },
      {
        id: "auto",
        label: "Auto OCR",
        icon: ICONS.auto,
        enabled: status.autoAvailable,
        detail: status.autoOcr ? "On" : "Off",
        unavailable: "Not in Quick Shot",
      },
    ].concat([
      {
        id: "history",
        label: "Recent text",
        icon: ICONS.text,
        enabled: typeof context.history === "function",
        unavailable: "Open recent text in Kimochi",
      },
      {
        id: "controls",
        label: "Kimochi",
        icon: ICONS.dictionary,
        enabled: true,
      },
      {
        id: "ocr-settings",
        label: "OCR settings",
        icon: ICONS.scan,
        enabled: true,
      },
    ]);
  }

  async function openHistory() {
    menu.close();
    setMode("history");
    controls.reset();
    const ticket = ++generation;
    try {
      const entries = await context.history();
      if (ticket !== generation || mode !== "history") return;
      const center = context.status().center ?? {
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      };
      history.show(entries, center);
    } catch (error) {
      context.log({
        check: "controller-history-failed",
        error: String(error?.message ?? error),
      });
      if (ticket === generation) await close();
    }
  }

  async function readHistory() {
    if (mode !== "history" || !history.read()) return;
    historical = true;
    await enterWords();
  }

  function backToHistory() {
    if (!historical) return;
    generation++;
    scroll(0);
    leaveWords();
    historical = false;
    setMode("history");
    controls.reset();
    history.showList();
  }

  async function openMenu(how = "pad") {
    input = how;
    controls.setButtons(context.buttons());
    const status = context.status();
    const center = status.center ?? {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    };
    const items = menuItems();
    // With automatic OCR on the text is usually already current, so reading along is the
    // likely choice: start on it, and A alone opens it.
    const initial =
      status.autoOcr && status.hasText
        ? items.findIndex((i) => i.id === "dictionary")
        : -1;
    menu.show(center, items, input, initial);
    if (mode === "idle") await setNav(true);
    setMode("menu");
    controls.reset();
  }

  /** Leave controller mode entirely and give the game its focus back. */
  async function close() {
    if (mode === "idle") return;
    generation++;
    const wasWords = mode === "words";
    const wasHistory = historical;
    setMode("idle");
    controls.reset();
    scroll(0);
    menu.close();
    // Finished reading: the text goes with the popup, until the next scan brings new text.
    if (wasWords) {
      leaveWords();
      if (!wasHistory) {
        hidText = true;
        void context.setText(false);
      }
    }
    historical = false;
    history.remove();
    await setNav(false);
  }

  async function choose(id) {
    if (id === "history") return openHistory();
    if (id === "dictionary") {
      menu.close();
      return enterWords();
    }
    await close();
    await new Promise((resolve) => setTimeout(resolve, ACTION_DELAY_MS));
    if (id !== "scan") return context.run(id);
    // Scan, then read: once the text is in, go straight to its first word. The game keeps its
    // focus while the scan runs, so it is captured as it looks when it is in front. With
    // automatic OCR on, the scan catches the loop up instead, and when the text drawn is
    // already current (`fresh`) there is nothing new to wait for: straight into reading.
    const before = context.status().scanId;
    const fresh = await context.scan();
    const after = context.status();
    if (
      mode !== "idle" ||
      !after.hasText ||
      (after.scanId === before && !fresh)
    )
      return;
    await setNav(true);
    if (mode !== "idle") return;
    input = "pad";
    controls.reset();
    await enterWords();
  }

  function handle(command) {
    if (command.type === "menu") return void close();
    if (mode === "menu") {
      if (command.type === "aim") menu.aim(command.x, command.y);
      else if (
        command.type === "dir" &&
        command.source !== "stick" &&
        !command.repeat
      )
        menu.direction(command.dir);
      else if (command.type === "confirm") {
        if (menu.selected < 0) return void close();
        menu.confirm();
      } else if (command.type === "cancel") void close();
      return;
    }
    if (mode === "history") {
      if (command.type === "cancel") return void close();
      if (command.type === "confirm") return void readHistory();
      if (command.type === "dir") history.move(command.dir);
      if (command.type === "scroll")
        history.content?.scrollBy(0, -command.y * 80);
      return;
    }
    if (mode === "words") {
      if (command.type === "cancel")
        return historical ? backToHistory() : void close();
      // The mouse had the text: any button or direction hands it back to the controller, at the
      // word it was on, and does nothing more — the reader is only picking it back up.
      if (driver === "mouse") {
        const deliberate =
          command.type === "dir" ||
          command.type === "confirm" ||
          command.type === "step" ||
          (command.type === "scroll" && command.y !== 0);
        if (deliberate) takeOver("controller");
        return;
      }
      if (command.type === "dir") moveTo(() => cursor?.move(command.dir));
      else if (command.type === "step") {
        context.log({
          check: "controller-definition-jump",
          delta: command.delta,
        });
        context.popupControl({ step: command.delta });
      } else if (command.type === "scroll") scroll(command.y);
      else if (command.type === "confirm") void lookup();
      else if (command.type === "cancel") void close();
    }
  }

  // --- word mode -------------------------------------------------------------

  /**
   * The scan's text in reading order, one unit per text node a lookup ranges over: the box's text
   * in word mode, and each laid-out line or word of a group in grouped mode.
   */
  function readUnits() {
    if (historical) return history.units();
    const units = [];
    for (const element of context.words.children) {
      if (!element.dataset?.ocrWordBox) continue;
      const vertical = element.classList.contains("ocr-vertical");
      const holders = element.querySelector(".ocr-word-current")
        ? [element.querySelector(".ocr-word-current")]
        : [...element.querySelectorAll(".ocr-run")];
      for (const holder of holders) {
        const node = [...holder.childNodes].find(
          (child) => child.nodeType === Node.TEXT_NODE,
        );
        if (!node?.textContent) continue;
        units.push({ element, node, text: node.textContent, vertical });
      }
    }
    return units;
  }

  /** Lean the right stick: scroll the popup until it is back at rest. */
  function scroll(y) {
    // Stick up scrolls up, towards the top of the definitions.
    scrollLean = -scrollSpeed(y);
    if (scrollLean === 0 || scrollFrame !== null) return;
    scrollAt = performance.now();
    const tick = (now) => {
      if (scrollLean === 0 || mode !== "words") {
        scrollFrame = null;
        return;
      }
      const seconds = Math.min(0.05, (now - scrollAt) / 1000);
      scrollAt = now;
      context.popupControl({ scroll: scrollLean * seconds });
      scrollFrame = requestAnimationFrame(tick);
    };
    scrollFrame = requestAnimationFrame(tick);
  }

  /** Start word mode, or with `rescan`, start over on new text keeping whoever is reading. */
  async function enterWords(rescan = false) {
    setMode("words");
    if (!rescan) {
      driver = "controller";
      pointerAnchor = lastPointer;
    }
    context.quietText(driver === "controller");
    const ticket = ++generation;
    context.redraw();
    showHud("Reading the text…");
    const api = context.dictionary();
    const parse = api
      ? (text) =>
          api("parseText", {
            text,
            optionsContext: { current: true },
            scanLength: SCAN_LENGTH,
            useInternalParser: true,
            useMecabParser: false,
          })
      : null;
    const units = readUnits();
    const segmented = await Promise.all(
      units.map(async (unit) => ({
        ...unit,
        tokens: await segmentText(unit.text, parse),
      })),
    );
    if (ticket !== generation || mode !== "words") return;
    cursor = new WordCursor(segmented);
    context.log({
      check: "controller-words",
      boxes: units.length,
      words: cursor.words.length,
    });
    if (!cursor.current) {
      showHud("No words found in the last scan");
      return;
    }
    render();
    if (driver === "controller") void lookup();
  }

  /**
   * Hand word mode to the controller or the mouse. The mouse gets the text as it always has —
   * lit boxes, hover lookups — with the outline and the controller's popup put away; the
   * controller gets them back where it left off.
   */
  function takeOver(next) {
    if (mode !== "words" || driver === next) return;
    driver = next;
    context.log({ check: "controller-driver", driver: next });
    if (next === "mouse") {
      scroll(0);
      context.dismiss();
      context.quietText(false);
      for (const segment of segments) segment.classList.add("cm-word-away");
      hud?.classList.add("cm-hud-away");
      return;
    }
    pointerAnchor = lastPointer;
    context.quietText(true);
    for (const segment of segments) segment.classList.remove("cm-word-away");
    hud?.classList.remove("cm-hud-away");
    render();
    void lookup();
  }

  function leaveWords() {
    driver = "controller";
    cursor = null;
    context.dismiss();
    context.quietText(false);
    for (const segment of segments) segment.remove();
    segments = [];
    highlight = null;
    hud?.classList.add("cm-leaving");
    const leaving = hud;
    setTimeout(() => leaving?.remove(), 250);
    hud = null;
    context.redraw();
  }

  function moveTo(step) {
    if (!cursor) return;
    if (!step()) {
      highlight?.classList.remove("cm-bump");
      void highlight?.offsetWidth;
      highlight?.classList.add("cm-bump");
      return;
    }
    render();
    void lookup();
  }

  function rangeFor(word) {
    const unit = cursor.units[word.unit];
    if (!unit.node.isConnected) return null;
    const range = document.createRange();
    range.setStart(unit.node, word.start);
    range.setEnd(unit.node, Math.min(word.end, unit.node.length));
    return range;
  }

  function wordRect(range) {
    const rects = [...range.getClientRects()].filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    if (!rects.length) return range.getBoundingClientRect();
    return union(
      rects.map((rect) => ({
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      })),
    );
  }

  function union(rects) {
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
    return { left, top, width: right - left, height: bottom - top };
  }

  /**
   * Where the word is on the source, one rectangle per line it spans.
   *
   * A word-mode box's own text is drawn to suit hovering, not to match the source, so its
   * characters are placed from the OCR geometry instead (`charRects`). Grouped text is already
   * laid over the source, so there the drawn text is where the word is.
   */
  function wordSegments(word, range) {
    const unit = cursor.units[word.unit];
    const cells = unit.history ? null : context.charRects?.(unit.element);
    if (cells) {
      const lines = new Map();
      for (let index = word.start; index < word.end; index++) {
        const cell = cells[index];
        if (!cell) continue;
        if (!lines.has(cell.line)) lines.set(cell.line, []);
        lines.get(cell.line).push(cell);
      }
      if (lines.size) return [...lines.values()].map(union);
    }
    return [wordRect(range)];
  }

  /** The outline pieces, one per line, reusing what is there so a one-line move glides. */
  let segments = [];

  function render() {
    const word = cursor?.current;
    if (!word) return;
    const range = rangeFor(word);
    if (!range) {
      // The scan was replaced underneath us; start again on the new text.
      void enterWords();
      return;
    }
    if (historical) history.ensureVisible(range);
    const rects = wordSegments(word, range);
    while (segments.length > rects.length) segments.pop().remove();
    while (segments.length < rects.length) {
      const segment = document.createElement("div");
      segment.className = "cm-word";
      host.append(segment);
      segments.push(segment);
    }
    highlight = segments[0];
    const vertical = cursor.vertical;
    const pad = 3;
    rects.forEach((rect, index) => {
      const segment = segments[index];
      Object.assign(segment.style, {
        left: `${rect.left - pad}px`,
        top: `${rect.top - pad}px`,
        width: `${rect.width + pad * 2}px`,
        height: `${rect.height + pad * 2}px`,
        // A word that carries on to the next line fades out where it breaks and back in where it
        // resumes, so the pieces read as one outline.
        maskImage: fadeFor(index > 0, index < rects.length - 1, vertical),
        webkitMaskImage: fadeFor(index > 0, index < rects.length - 1, vertical),
      });
      segment.classList.toggle("cm-word-vertical", vertical);
      segment.classList.toggle("cm-word-away", driver === "mouse");
    });
    showHud(null);
  }

  function fadeFor(continued, continues, vertical) {
    if (!continued && !continues) return "none";
    const direction = vertical ? "to bottom" : "to right";
    const start = continued ? "transparent 0%, #000 30%" : "#000 0%";
    const end = continues ? "#000 70%, transparent 100%" : "#000 100%";
    return `linear-gradient(${direction}, ${start}, ${end})`;
  }

  function showHud(message) {
    if (!hud) {
      hud = document.createElement("div");
      hud.className = "cm-hud";
      host.append(hud);
    }
    // Along the bottom of the source, clear of the text more often than not; the bottom of the
    // display when the source's position is unknown.
    const { area } = context.status();
    if (area) {
      hud.style.left = `${area.x + area.width / 2}px`;
      hud.style.top = `${Math.min(area.y + area.height, window.innerHeight) - 64}px`;
      hud.style.bottom = "auto";
    }
    const keys = input === "keys";
    const vertical = cursor?.vertical;
    const word = keys ? (vertical ? "↑ ↓" : "← →") : vertical ? "▲ ▼" : "◀ ▶";
    const line = keys ? (vertical ? "← →" : "↑ ↓") : vertical ? "◀ ▶" : "▲ ▼";
    const count = cursor?.current
      ? `${cursor.index + 1} / ${cursor.words.length}`
      : "";
    hud.innerHTML = `
      <span class="cm-hud-mark">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS.dictionary + "</svg>"}</span>
      <span class="cm-hud-message"></span>
      <span class="cm-hint"><kbd class="cm-glyph">${word}</kbd>Word</span>
      <span class="cm-hint"><kbd class="cm-glyph">${line}</kbd>${vertical ? "Column" : "Line"}</span>
      ${keys ? "" : '<span class="cm-hint"><kbd class="cm-glyph">LB RB</kbd>Definition</span><span class="cm-hint"><kbd class="cm-glyph">RS</kbd>Scroll</span>'}
      <span class="cm-hint"><kbd class="cm-glyph cm-cancel">${keys ? "esc" : "B"}</kbd>${historical ? "Recent text" : "Back to game"}</span>`;
    hud.querySelector(".cm-hud-message").textContent = message ?? count;
    hud.classList.toggle("cm-hud-away", driver === "mouse");
  }

  async function lookup() {
    const word = cursor?.current;
    if (!word) return;
    const range = rangeFor(word);
    if (!range) return;
    const unit = cursor.units[word.unit];
    try {
      if (context.popupType() === "custom-api") {
        const rect = wordRect(range);
        const origin = context.status().origin ?? { x: 0, y: 0 };
        await context.lookupTerm(
          unit.text.slice(word.start),
          origin.x + rect.left + rect.width / 2,
          origin.y + rect.top + rect.height / 2,
          unit.text,
        );
      } else {
        // From the word to the end of its box: Yomitan finds the longest match itself, and
        // gets to read past the parser's split when deinflection allows a longer one.
        range.setEnd(unit.node, unit.node.length);
        await context.lookupRange(range);
      }
    } catch (error) {
      context.log({
        check: "controller-lookup-failed",
        error: String(error?.message ?? error),
      });
    }
  }

  return {
    get mode() {
      return mode;
    },
    /** True while the scan's text must stay drawn, whatever its usual visibility rules say. */
    get holdsText() {
      return mode === "words" && !historical;
    },
    /** True while the controller, not the mouse, is reading: the pointer must not drive lookups. */
    get drivesLookups() {
      return mode === "words" && driver === "controller";
    },
    /**
     * The pointer moved, in overlay coordinates. Moving it well clear of where it was, near the
     * text, hands word mode to the mouse.
     */
    pointer(x, y) {
      lastPointer = { x, y };
      if (mode !== "words" || driver !== "controller") return;
      if (!pointerAnchor) {
        pointerAnchor = { x, y };
        return;
      }
      if (Math.hypot(x - pointerAnchor.x, y - pointerAnchor.y) < MOUSE_TAKEOVER)
        return;
      if (context.nearText(x, y)) takeOver("mouse");
      else pointerAnchor = { x, y };
    },
    /**
     * The mouse is over the text. Only movement counts: a box under a resting cursor can report
     * the mouse entering it the moment it becomes interactive, which is not the reader reaching
     * for the mouse.
     */
    mouseActivity() {
      if (
        mode !== "words" ||
        driver !== "controller" ||
        !pointerAnchor ||
        !lastPointer
      )
        return;
      const moved = Math.hypot(
        lastPointer.x - pointerAnchor.x,
        lastPointer.y - pointerAnchor.y,
      );
      if (moved >= 6) takeOver("mouse");
    },
    /** The mouse clicked the text: it takes over at once. */
    mouseUsed() {
      if (mode === "words") takeOver("mouse");
    },
    /** The menu button: open the menu, or close whatever is open. */
    toggle(how = "pad") {
      return mode === "idle" ? openMenu(how) : close();
    },
    /** Open recent text directly, sharing the radial menu's navigation ownership. */
    async recentText() {
      if (typeof context.history !== "function") return;
      if (mode !== "idle") await close();
      controls.setButtons(context.buttons());
      await setNav(true);
      return openHistory();
    },
    close,
    /** What the overlay must take clicks over while the menu is up. */
    hitRects() {
      const bounds = menu.bounds();
      const historyBounds = history.bounds();
      return [bounds, historyBounds].filter(Boolean);
    },
    /** A new scan was applied: in word mode, carry on over the new text from its first word. */
    scanChanged(hasText) {
      if (historical || mode === "history") return;
      if (hidText && hasText && mode !== "words") {
        hidText = false;
        void context.setText(true);
      }
      if (mode === "words") void enterWords(true);
    },
  };
}

export default { createController };

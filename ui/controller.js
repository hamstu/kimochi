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
 *
 * With the Yomitan API and Settings → Game mode's full-screen dictionary on, Read along opens
 * `dictionary` instead of `words`: the scan across the top of a dimmed screen and the lit word's
 * entry below it (ui/game-dictionary.js).
 *
 * Reading (words) steps by word or, with Y, by character; the left stick moves a free cursor that
 * looks up whatever character it rests on, and the D-pad snaps back to stepping from there. A on
 * the word moves into the pop-up (`layer`): the D-pad then moves between its buttons, A presses
 * one, B comes back to the text. View shows every control.
 */
import { ControllerInput, buttonName } from "./controller-input.js";
import { RadialMenu, ICONS } from "./radial-menu.js";
import {
  WordCursor,
  characterUnits,
  dominantVertical,
  readingUnits,
  segmentAcross,
  segmentText,
  SCAN_LENGTH,
} from "./word-nav.js";
import { ControllerHistory } from "./controller-history.js";
import { GameDictionary } from "./game-dictionary.js";

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

/**
 * The free cursor's speed, in points per second, for a left stick `magnitude` out of 1: a light
 * push creeps across a character, a full push crosses the screen in about a second. Native
 * reports the stick from its 0.25 radial deadzone outwards.
 */
const POINTER_MIN = 140;
const POINTER_MAX = 1500;
export function pointerSpeed(magnitude) {
  if (magnitude < SCROLL_DEADZONE) return 0;
  const t = Math.min(1, (magnitude - SCROLL_DEADZONE) / (1 - SCROLL_DEADZONE));
  return POINTER_MIN + (POINTER_MAX - POINTER_MIN) * t * t;
}
/** How long the free cursor rests on a character before it is looked up, so a glide is not a flood. */
const POINTER_DWELL_MS = 70;
/** How far from a character the free cursor may be and still be on it. */
const POINTER_REACH = 14;

/**
 * The character the free cursor is on: the one whose rectangles (one list per character) come
 * nearest (x, y), if that is within `reach` points; -1 when none is.
 */
export function characterAt(targets, x, y, reach) {
  let best = -1;
  let nearest = Infinity;
  targets.forEach((rects, index) => {
    for (const rect of rects) {
      const dx = Math.max(rect.left - x, 0, x - (rect.left + rect.width));
      const dy = Math.max(rect.top - y, 0, y - (rect.top + rect.height));
      const distance = Math.hypot(dx, dy);
      if (distance < nearest) {
        nearest = distance;
        best = index;
      }
    }
  });
  return nearest <= reach ? best : -1;
}

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
 * @param {(control: {scroll?: number, step?: number, focus?: string}) => boolean} context.popupControl scroll
 *   the open popup by `scroll` points, jump `step` definitions through it, or move the focus over
 *   its buttons (`focus`: 'enter', 'exit', 'refocus', a direction, 'press' or 'audio'; see
 *   ui/popup-focus.js), answering whether the focus request did anything
 * @param {() => boolean} [context.popupFocusable] whether the engine's popup has buttons the
 *   controller can focus (Yomitan, Hachidori; not 10ten or the Yomitan API pop-up)
 * @param {() => void} context.redraw redraw the text overlay (it is held visible in word mode)
 * @param {() => ((action: string, params: object) => Promise<any>)|null} context.dictionary Yomitan's backend API, once ready
 * @param {() => object} context.buttons the command buttons from settings (`controllerButtons`)
 * @param {() => string} context.popupType `yomitanSettings.popupType`: only `custom-api` (the Yomitan
 *   API pop-up) is told apart; `builtin` (Yomitan), `hachidori` and `tenten` all look up by range
 * @param {(range: Range) => Promise<boolean>} context.lookupRange open the dictionary engine's popup
 *   on a range (Yomitan's frontend, or the extension host's `lookupRange`)
 * @param {(term: string, x: number, y: number, sentence: string) => Promise<void>} context.lookupTerm open the Yomitan API pop-up
 * @param {(text: string) => Promise<unknown>} context.apiParse the Yomitan API's `/tokenize` (its parse results)
 * @param {() => ({startContainer: Node, startOffset: number, endContainer: Node, endOffset: number}|null)} [context.matchedRange]
 *   the text the open popup's lookup matched, where an extension engine marks it
 * @param {() => void} context.dismiss close whichever popup is open
 * @param {(element: HTMLElement) => ({x: number, y: number, width: number, height: number, line: number}|null)[]|null} context.charRects
 *   where each character of a word-mode box is on the source, by code unit; null in grouped mode
 * @param {(quiet: boolean) => void} context.quietText hold the text overlay's boxes unlit
 * @param {(visible: boolean) => Promise<void>} context.setText the overlay's text switch, as the main window shows it
 * @param {(x: number, y: number) => boolean} context.nearText whether a point is on or close to scanned text
 * @param {(record: object) => void} context.log
 * @param {(mode: 'idle' | 'menu' | 'words' | 'dictionary' | 'history') => void} [context.modeChanged] the menu opened, word
 *   mode started, or controller mode ended; automatic OCR stands still while it is anything but idle
 * @param {() => Promise<object[]>} context.history read durable recent text without publishing it
 * @param {object} [context.fullDictionary] Read along as the full-screen dictionary instead of the
 *   outline and pop-up, while `enabled()` (the Yomitan API, and Settings → Game mode says so):
 *   `lookup`, `anki` and `play` for ui/game-dictionary.js
 */
export function createController(context) {
  const { host, native } = context;
  let mode = "idle";
  function setMode(next) {
    if (next === mode) return;
    if (next !== "idle") applyAppearance();
    mode = next;
    context.modeChanged?.(next);
  }
  /**
   * Kimochi's appearance for the controller's surfaces (controller-variants.css): the app's
   * Light or Dark, or the system's when it follows the system. Read each time controller mode
   * opens, so a change in Settings shows the next time.
   */
  function applyAppearance() {
    const appearance = context.appearance?.();
    const theme =
      appearance === "light" || appearance === "dark"
        ? appearance
        : globalThis.matchMedia?.("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
    if (host.dataset) host.dataset.cmTheme = theme;
  }
    /** How the mode was opened, so the hints name the right buttons. */
  let input = "pad";
  /** The cursor the outline shows: the word cursor, or the character one (by character, or the free cursor). */
  let cursor = null;
  let wordCursor = null;
  let charCursor = null;
  /** What the D-pad steps by; kept across scans and readings for the session. */
  let unit = "word";
  /** Where A, B and the D-pad act: the text, or the buttons of the dictionary pop-up. */
  let layer = "text";
  /** The free cursor: where it is (overlay points), the stick driving it, the frame loop moving it. */
  const pointer = {
    active: false,
    x: 0,
    y: 0,
    stick: { x: 0, y: 0 },
    frame: null,
    at: 0,
    element: null,
    targets: null,
    char: -1,
    dwell: null,
  };
  /** The full list of controls (View), while it is open. */
  let sheet = null;
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

  /** Read along's full-screen look (mode `dictionary`), when the overlay offers it. */
  const fullView = context.fullDictionary
    ? new GameDictionary(host, {
        lookup: (term, options) => context.fullDictionary.lookup(term, options),
        anki: () => context.fullDictionary.anki(),
        play: (item) => context.fullDictionary.play(item),
        glyph: (action) => glyphOf(action),
        input: () => input,
        onClose: () => void (historical ? backToHistory() : close()),
        log: (record) => context.log(record),
      })
    : null;

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
        icon: ICONS.history,
        enabled: typeof context.history === "function",
        unavailable: "Open recent text in Kimochi",
      },
      {
        id: "controls",
        label: "Kimochi",
        icon: ICONS.app,
        enabled: true,
      },
      {
        id: "ocr-settings",
        label: "OCR settings",
        icon: ICONS.settings,
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
    if (mode === "dictionary") fullView.remove();
    else leaveWords();
    historical = false;
    setMode("history");
    controls.reset();
    history.showList();
  }

  async function openMenu(how = "pad") {
    input = how;
    applyAppearance();
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
    const wasWords = mode === "words" || mode === "dictionary";
    const wasHistory = historical;
    fullView?.remove();
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
    // Gaming Mode transfers the live input lease to controls before the radial
    // closes. Releasing first lets the game receive input during the handoff.
    if (context.panelInputHandoff && (id === "controls" || id === "ocr-settings")) {
      try { await context.run(id); } finally { await close(); }
      return;
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
    if (mode === "dictionary") {
      if (command.type === "cancel") return historical ? backToHistory() : void close();
      if (command.type === "dir" && command.source !== "stick") return void fullView.move(command.dir);
      if (command.type === "step") return fullView.step(command.delta);
      if (command.type === "scroll") return void scroll(command.y);
      if (command.type === "confirm") return void fullView.confirm();
      if (command.type === "audio") return void fullView.audio();
      return;
    }
    if (mode === "words") {
      // The list of controls is on top of everything: its own button or B puts it away.
      if (sheet) {
        if (command.type === "help" || command.type === "cancel") hideSheet();
        return;
      }
      if (command.type === "help") return void showSheet();
      if (command.type === "cancel") {
        if (layer === "popup") return void leavePopup();
        return historical ? backToHistory() : void close();
      }
      // The mouse had the text: any button or direction hands it back to the controller, at the
      // word it was on, and does nothing more — the reader is only picking it back up.
      if (driver === "mouse") {
        const deliberate =
          command.type === "dir" ||
          command.type === "confirm" ||
          command.type === "step" ||
          command.type === "unit" ||
          command.type === "audio" ||
          (command.type === "aim" && (command.x !== 0 || command.y !== 0)) ||
          (command.type === "scroll" && command.y !== 0);
        if (deliberate) takeOver("controller");
        return;
      }
      if (command.type === "aim") return void aimPointer(command.x, command.y);
      if (command.type === "dir") {
        // The left stick drives the free cursor, not steps.
        if (command.source === "stick") return;
        if (layer === "popup") {
          if (!context.popupControl({ focus: command.dir })) bumpHud();
          return;
        }
        if (pointer.active) return void snapToPointer();
        return void moveTo(() => cursor?.move(command.dir));
      }
      if (command.type === "step") {
        context.log({
          check: "controller-definition-jump",
          delta: command.delta,
        });
        context.popupControl({ step: command.delta });
        // The focus follows to the entry the jump lands on, once it has scrolled there.
        if (layer === "popup")
          setTimeout(() => {
            if (layer === "popup") context.popupControl({ focus: "refocus" });
          }, 180);
        return;
      }
      if (command.type === "scroll") return void scroll(command.y);
      if (command.type === "confirm") {
        if (layer === "popup") {
          if (!context.popupControl({ focus: "press" })) bumpHud();
          return;
        }
        if (context.popupFocusable?.() && context.popupControl({ focus: "enter" })) {
          layer = "popup";
          context.log({ check: "controller-popup-focus", entered: true });
          showHud(null);
          return;
        }
        return void lookup();
      }
      if (command.type === "unit") {
        if (layer === "popup") return;
        return void toggleUnit();
      }
      if (command.type === "audio") {
        if (!context.popupControl({ focus: "audio" })) bumpHud();
      }
    }
  }

  // --- the pop-up's buttons, and the list of controls ------------------------------

  /** Back from the pop-up's buttons to the text, the popup left open. */
  function leavePopup() {
    if (layer !== "popup") return;
    layer = "text";
    context.popupControl({ focus: "exit" });
    showHud(null);
  }

  /** A nudge on the hint bar: that press had nothing to do (no button that way, no audio). */
  function bumpHud() {
    if (!hud) return;
    hud.classList.remove("cm-hud-bump");
    void hud.offsetWidth;
    hud.classList.add("cm-hud-bump");
  }

  function showSheet() {
    if (sheet) return;
    sheet = document.createElement("div");
    sheet.className = "cm-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "Controller controls");
    const { area } = context.status();
    if (area) {
      sheet.style.left = `${area.x + area.width / 2}px`;
      sheet.style.top = `${area.y + area.height / 2}px`;
    }
    sheet.innerHTML = sheetHtml();
    host.append(sheet);
    context.log({ check: "controller-controls-sheet", open: true });
  }

  function hideSheet() {
    if (!sheet) return;
    const leaving = sheet;
    sheet = null;
    leaving.classList.add("cm-leaving");
    setTimeout(() => leaving.remove(), 200);
  }

  // --- word and character steps, and the free cursor -------------------------------

  /** Step by word, or by character, from where the outline is. */
  function toggleUnit() {
    const next = unit === "word" ? "char" : "word";
    const target = next === "word" ? wordCursor : charCursor;
    if (!target?.words.length) return void bumpHud();
    unit = next;
    const at = cursor?.current;
    if (at) target.seek(at.unit, at.start);
    hidePointer();
    cursor = target;
    context.log({ check: "controller-unit", unit });
    render();
    void lookup();
  }

  /** The left stick moved: start, steer or rest the free cursor. */
  function aimPointer(x, y) {
    pointer.stick = { x, y };
    if (x === 0 && y === 0) return;
    if (!charCursor?.words.length) return;
    if (layer === "popup") leavePopup();
    if (!pointer.active) startPointer();
    if (pointer.frame === null) {
      pointer.at = performance.now();
      pointer.frame = requestAnimationFrame(tickPointer);
    }
  }

  function startPointer() {
    pointer.active = true;
    pointer.char = -1;
    // From the middle of the word the outline is on, so the cursor picks up where the reader is.
    const word = cursor?.current;
    const range = word ? rangeFor(word) : null;
    const rect = range ? wordRect(range) : null;
    const { area } = context.status();
    pointer.x = rect ? rect.left + rect.width / 2 : (area ? area.x + area.width / 2 : window.innerWidth / 2);
    pointer.y = rect ? rect.top + rect.height / 2 : (area ? area.y + area.height / 2 : window.innerHeight / 2);
    if (!pointer.element) {
      pointer.element = document.createElement("div");
      pointer.element.className = "cm-free-cursor";
      host.append(pointer.element);
    }
    placePointer();
    cursor = charCursor;
    context.log({ check: "controller-pointer", active: true });
    showHud(null);
  }

  function tickPointer(now) {
    const { x, y } = pointer.stick;
    const magnitude = Math.hypot(x, y);
    if (!pointer.active || mode !== "words" || magnitude === 0) {
      pointer.frame = null;
      return;
    }
    const seconds = Math.min(0.05, (now - pointer.at) / 1000);
    pointer.at = now;
    const speed = pointerSpeed(magnitude) * seconds;
    // y is up on the stick, down on the screen.
    pointer.x += (x / magnitude) * speed;
    pointer.y -= (y / magnitude) * speed;
    const { area } = context.status();
    const bounds = area ?? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    pointer.x = Math.max(bounds.x, Math.min(bounds.x + bounds.width, pointer.x));
    pointer.y = Math.max(bounds.y, Math.min(bounds.y + bounds.height, pointer.y));
    placePointer();
    hoverPointer();
    pointer.frame = requestAnimationFrame(tickPointer);
  }

  function placePointer() {
    if (pointer.element)
      pointer.element.style.transform = `translate(${pointer.x}px, ${pointer.y}px)`;
  }

  /** Where every character is, once per reading: the free cursor finds what it is on from these. */
  function pointerTargets() {
    if (!pointer.targets) {
      pointer.targets = charCursor.words.map((word) => {
        const range = rangeFor(word);
        return range ? wordSegments(word, range) : [];
      });
    }
    return pointer.targets;
  }

  /** The character under the free cursor, looked up once the cursor rests on it. */
  function hoverPointer() {
    const index = characterAt(pointerTargets(), pointer.x, pointer.y, POINTER_REACH);
    if (index < 0 || index === pointer.char) return;
    pointer.char = index;
    charCursor.index = index;
    cursor = charCursor;
    render();
    clearTimeout(pointer.dwell);
    pointer.dwell = setTimeout(() => {
      if (pointer.active && charCursor?.index === index) void lookup();
    }, POINTER_DWELL_MS);
  }

  /** The D-pad after the free cursor: carry on stepping from the character it was on. */
  function snapToPointer() {
    const at = charCursor?.current;
    hidePointer();
    cursor = unit === "word" ? wordCursor : charCursor;
    if (at) cursor.seek(at.unit, at.start);
    render();
    void lookup();
  }

  function hidePointer() {
    if (!pointer.active) return;
    pointer.active = false;
    clearTimeout(pointer.dwell);
    pointer.dwell = null;
    if (pointer.frame !== null) cancelAnimationFrame(pointer.frame);
    pointer.frame = null;
    const leaving = pointer.element;
    pointer.element = null;
    leaving?.classList.add("cm-leaving");
    setTimeout(() => leaving?.remove(), 200);
    context.log({ check: "controller-pointer", active: false });
  }

  // --- word mode -------------------------------------------------------------

  /**
   * The scan's text in reading order, one unit per text node a lookup ranges over: the box's text
   * in word mode (each of its lines, for a block drawn line by line), and each laid-out line or
   * word of a group in grouped mode.
   */
  function readUnits() {
    if (historical) return history.units();
    const units = [];
    for (const element of context.words.children) {
      if (!element.dataset?.ocrWordBox) continue;
      const vertical = element.classList.contains("ocr-vertical");
      const current = element.querySelector(".ocr-word-current");
      const holders =
        current &&
        [...current.childNodes].some((child) => child.nodeType === Node.TEXT_NODE)
          ? [current]
          : [...element.querySelectorAll(".ocr-run")];
      for (const holder of holders) {
        const node = [...holder.childNodes].find(
          (child) => child.nodeType === Node.TEXT_NODE,
        );
        if (!node?.textContent) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const { left, top, width, height } = range.getBoundingClientRect();
        units.push({
          element,
          node,
          text: node.textContent,
          vertical,
          box: { x: left, y: top, width, height },
        });
      }
    }
    return readingUnits(units, dominantVertical(units));
  }

  /** Lean the right stick: scroll the popup until it is back at rest. */
  function scroll(y) {
    // Stick up scrolls up, towards the top of the definitions.
    scrollLean = -scrollSpeed(y);
    if (scrollLean === 0 || scrollFrame !== null) return;
    scrollAt = performance.now();
    const tick = (now) => {
      if (scrollLean === 0 || (mode !== "words" && mode !== "dictionary")) {
        scrollFrame = null;
        return;
      }
      const seconds = Math.min(0.05, (now - scrollAt) / 1000);
      scrollAt = now;
      if (mode === "dictionary") fullView.scroll(scrollLean * seconds);
      else context.popupControl({ scroll: scrollLean * seconds });
      scrollFrame = requestAnimationFrame(tick);
    };
    scrollFrame = requestAnimationFrame(tick);
  }

  /** Start word mode, or with `rescan`, start over on new text keeping whoever is reading. */
  async function enterWords(rescan = false) {
    if (fullView && context.fullDictionary.enabled()) return enterDictionary();
    setMode("words");
    if (!rescan) {
      driver = "controller";
      pointerAnchor = lastPointer;
    }
    context.quietText(driver === "controller");
    const ticket = ++generation;
    context.redraw();
    showHud("Reading the text…");
    // Words split the way the dictionary in use would match them: the Yomitan API's own
    // `/tokenize` with its dictionaries; else the built-in Yomitan's parser; else (Hachidori,
    // 10ten) the platform's segmenter, kanji kept with their kana (`tokensFromSegmenter`).
    const api = context.dictionary();
    const parse =
      context.popupType() === "custom-api"
        ? context.apiParse
        : api
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
    const segmented = await segmentAcross(units, (text) =>
      segmentText(text, parse),
    );
    if (ticket !== generation || mode !== "words") return;
    hidePointer();
    leavePopup();
    pointer.targets = null;
    wordCursor = new WordCursor(segmented);
    charCursor = new WordCursor(characterUnits(segmented));
    // Text the dictionary matched nothing in still has characters to step through.
    if (unit === "word" && !wordCursor.words.length && charCursor.words.length) unit = "char";
    cursor = unit === "word" ? wordCursor : charCursor;
    context.log({
      check: "controller-words",
      boxes: units.length,
      words: wordCursor.words.length,
      characters: charCursor.words.length,
      unit,
    });
    if (!cursor.current) {
      showHud("No words found in the last scan");
      return;
    }
    render();
    if (driver === "controller") void lookup();
  }

  /**
   * Read along as the full-screen dictionary: the scan's words, split by the Yomitan API's
   * `/tokenize`, across the top of the screen and the lit word's entry below.
   */
  async function enterDictionary() {
    if (mode === "words") leaveWords();
    setMode("dictionary");
    const ticket = ++generation;
    context.redraw();
    const segmented = await segmentAcross(readUnits(), (text) =>
      segmentText(text, context.apiParse),
    );
    if (ticket !== generation || mode !== "dictionary") return;
    context.log({ check: "controller-dictionary", boxes: segmented.length });
    fullView.show(segmented, { title: historical ? "Recent text" : "Read along" });
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
      hidePointer();
      hideSheet();
      leavePopup();
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
    hidePointer();
    hideSheet();
    leavePopup();
    cursor = null;
    wordCursor = null;
    charCursor = null;
    pointer.targets = null;
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
    leavePopup();
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
    return spanRange(word.unit, word.start, word.end - word.start);
  }

  /**
   * `length` characters from (unit, start), running on through the next units in reading order
   * where they reach past the unit's end (a word OCR split across boxes, or a lookup reading on),
   * as far as the text goes.
   */
  function spanRange(unitIndex, start, length) {
    const unit = cursor.units[unitIndex];
    if (!unit.node.isConnected) return null;
    const range = document.createRange();
    range.setStart(unit.node, start);
    let remaining = length;
    for (let index = unitIndex; index < cursor.units.length; index++) {
      const node = cursor.units[index].node;
      if (!node.isConnected) break;
      const from = index === unitIndex ? start : 0;
      const take = Math.min(node.length - from, remaining);
      range.setEnd(node, from + take);
      remaining -= take;
      if (remaining <= 0) break;
    }
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
   * A word-mode box's characters come from the runs its text is fitted with (`charRects`), which
   * hold even while the box's text is hidden and its lookahead carries the next boxes' words.
   * Grouped text, and a block's lines, are laid over the source as drawn, so there the drawn text
   * is where the word is.
   */
  function wordSegments(word, range) {
    const lines = new Map();
    // The word's characters in its own box, then any it runs on into the next boxes.
    let start = word.start;
    let remaining = word.end - word.start;
    for (let index = word.unit; index < cursor.units.length && remaining > 0; index++) {
      const unit = cursor.units[index];
      const cells = unit.history ? null : context.charRects?.(unit.element);
      if (!cells) return [wordRect(range)];
      const end = Math.min(unit.text.length, start + remaining);
      for (let at = start; at < end; at++) {
        const cell = cells[at];
        if (!cell) continue;
        const key = `${index}:${cell.line}`;
        if (!lines.has(key)) lines.set(key, []);
        lines.get(key).push(cell);
      }
      remaining -= end - start;
      start = 0;
    }
    return lines.size ? [...lines.values()].map(union) : [wordRect(range)];
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
    // Drawn the way this word's own box runs; the keys follow the scan's direction instead.
    const vertical = Boolean(cursor.units[word.unit]?.vertical);
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

  /** A bound action's button, as drawn on screen; null when it is unbound. */
  function glyphOf(action) {
    return buttonName(controls.buttons[action]);
  }

  const escapeHtml = (text) =>
    String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  /** One hint: its key or button, and what it does; nothing for an unbound button. */
  function hint(glyph, label, tone = "") {
    if (!glyph) return "";
    return `<span class="cm-hint"><kbd class="cm-glyph${tone ? ` cm-${tone}` : ""}">${escapeHtml(glyph)}</kbd>${escapeHtml(label)}</span>`;
  }

  /** The directions, the way the current text runs: along it for the next stop, across for the next line. */
  function directionGlyphs() {
    const keys = input === "keys";
    const vertical = cursor?.vertical;
    return {
      along: keys ? (vertical ? "↑ ↓" : "← →") : vertical ? "▲ ▼" : "◀ ▶",
      across: keys ? (vertical ? "← →" : "↑ ↓") : vertical ? "◀ ▶" : "▲ ▼",
      all: keys ? "← ↑ ↓ →" : "D-pad",
    };
  }

  /** What the reader is doing now, for the badge: stepping, pointing, or in the pop-up. */
  function modeLabel() {
    if (layer === "popup") return "Pop-up";
    if (pointer.active) return "Cursor";
    return unit === "word" ? "Word" : "Character";
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
    const dirs = directionGlyphs();
    const vertical = cursor?.vertical;
    const count = cursor?.current
      ? `${cursor.index + 1} / ${cursor.words.length}`
      : "";
    const back = historical ? "Recent text" : "Back to game";
    let hints;
    if (layer === "popup") {
      hints = keys
        ? hint(dirs.all, "Choose") + hint("return", "Press", "confirm") + hint("esc", "Back to text", "cancel")
        : hint(dirs.all, "Choose") +
          hint(glyphOf("confirm"), "Press", "confirm") +
          hint(glyphOf("playAudio"), "Audio") +
          hint(
            [glyphOf("previousDefinition"), glyphOf("nextDefinition")].filter(Boolean).join(" "),
            "Entry",
          ) +
          hint(glyphOf("back"), "Back to text", "cancel");
    } else {
      const other = unit === "word" ? "By character" : "By word";
      const select = context.popupFocusable?.() ? "Pop-up" : "Look up";
      hints = keys
        ? hint(dirs.along, unit === "word" ? "Word" : "Character") +
          hint(dirs.across, vertical ? "Column" : "Line") +
          hint("return", select, "confirm") +
          hint("space", other) +
          hint("esc", back, "cancel")
        : (pointer.active
            ? hint("LS", "Point") + hint("D-pad", "Step from here")
            : hint(dirs.along, unit === "word" ? "Word" : "Character") +
              hint(dirs.across, vertical ? "Column" : "Line")) +
          hint(glyphOf("confirm"), select, "confirm") +
          hint(glyphOf("toggleUnit"), other) +
          hint(glyphOf("showControls"), "Controls") +
          hint(glyphOf("back"), back, "cancel");
    }
    hud.innerHTML = `
      <span class="cm-hud-mark">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS.dictionary + "</svg>"}</span>
      <span class="cm-hud-mode" data-mode="${layer === "popup" ? "popup" : pointer.active ? "pointer" : unit}"></span>
      <span class="cm-hud-message"></span>
      ${hints}`;
    hud.querySelector(".cm-hud-mode").textContent = modeLabel();
    hud.querySelector(".cm-hud-message").textContent = message ?? count;
    hud.classList.toggle("cm-hud-away", driver === "mouse");
  }

  /** Every control while reading, with the buttons as they are bound now. */
  function sheetHtml() {
    const pair = (a, b) => [glyphOf(a), glyphOf(b)].filter(Boolean).join(" ");
    const row = (glyph, label, detail) =>
      glyph
        ? `<li><kbd class="cm-glyph">${escapeHtml(glyph)}</kbd><span><b>${escapeHtml(label)}</b>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</span></li>`
        : "";
    const popupButtons = context.popupFocusable?.();
    const reading = [
      row("D-pad", "Step through the text", "◀ ▶ along a line, ▲ ▼ to the next line (columns, in vertical text)"),
      row(glyphOf("toggleUnit"), "By word or by character", "By character, a lookup starts at that character: for a word split in the wrong place"),
      row("LS", "Free cursor", "Point at any character with the left stick; the D-pad steps on from there"),
      row(glyphOf("confirm"), popupButtons ? "Into the pop-up" : "Look up again", popupButtons ? "Use its buttons: add to Anki, play audio" : ""),
      row(glyphOf("playAudio"), "Play audio", ""),
      row(pair("previousDefinition", "nextDefinition"), "Previous or next definition", ""),
      row("RS", "Scroll the pop-up", "Push further to scroll faster"),
      row(glyphOf("back"), historical ? "Back to recent text" : "Back to the game", ""),
    ].join("");
    const inPopup = popupButtons
      ? [
          row("D-pad", "Choose a button", "The nearest one that way"),
          row(glyphOf("confirm"), "Press it", `Add to Anki is chosen first, so ${glyphOf("confirm")}, ${glyphOf("confirm")} adds the word`),
          row(pair("previousDefinition", "nextDefinition"), "Previous or next entry", ""),
          row(glyphOf("back"), "Back to the text", ""),
        ].join("")
      : "";
    return `
      <header><span class="cm-title">Controls</span><span class="cm-sheet-close">${hint(glyphOf("showControls") ?? glyphOf("back"), "Close")}</span></header>
      <div class="cm-sheet-columns">
        <section><h3>Reading</h3><ul>${reading}</ul></section>
        ${inPopup ? `<section><h3>In the pop-up</h3><ul>${inPopup}</ul></section>` : ""}
      </div>
      <footer>Change these buttons in Settings → Shortcuts &amp; Controls.</footer>`;
  }

  async function lookup() {
    const word = cursor?.current;
    if (!word) return;
    const range = rangeFor(word);
    if (!range) return;
    const unit = cursor.units[word.unit];
    // From the word on, past the end of its box when the text runs on, as a mouse lookup reads:
    // every dictionary finds the longest match from there itself (作った, not 作).
    const ahead = spanRange(word.unit, word.start, SCAN_LENGTH);
    // A new lookup replaces the popup's entries, and the focus on its buttons with them.
    leavePopup();
    try {
      if (context.popupType() === "custom-api") {
        const rect = wordRect(range);
        const origin = context.status().origin ?? { x: 0, y: 0 };
        await context.lookupTerm(
          ahead?.toString() || unit.text.slice(word.start),
          origin.x + rect.left + rect.width / 2,
          origin.y + rect.top + rect.height / 2,
          unit.text,
        );
      } else {
        await context.lookupRange(ahead ?? range);
        // Only a word is fitted to the match: a character is where the reader chose to start.
        if (cursor === wordCursor) void fitToMatch(word);
      }
    } catch (error) {
      context.log({
        check: "controller-lookup-failed",
        error: String(error?.message ?? error),
      });
    }
  }

  /**
   * Fit the outline to what the dictionary matched. Hachidori and 10ten mark the match on the page
   * (`context.matchedRange`); when it starts where the word does and is a different length (the
   * fallback split is a guess: 剣でも for 剣), the word becomes the match. Waits for the popup a
   * little, since the lookup resolves before the engine has drawn it.
   */
  async function fitToMatch(word) {
    if (!context.matchedRange) return;
    const unit = cursor.units[word.unit];
    for (let tries = 0; tries < 20; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (cursor?.current !== word) return; // moved on
      const match = context.matchedRange();
      if (!match) continue;
      if (match.startContainer !== unit.node || match.startOffset !== word.start) return;
      // The match's length in this unit's text and the units it runs on into.
      let length = 0;
      for (let index = word.unit; index < cursor.units.length; index++) {
        const node = cursor.units[index].node;
        const from = index === word.unit ? word.start : 0;
        if (node === match.endContainer) {
          length += match.endOffset - from;
          if (cursor.fit(length)) render();
          context.log({ check: "controller-fit-match", length });
          return;
        }
        length += node.length - from;
      }
      return;
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
      return [bounds, historyBounds, fullView?.bounds()].filter(Boolean);
    },
    /** A new scan was applied: in word mode, carry on over the new text from its first word. */
    scanChanged(hasText) {
      if (historical || mode === "history") return;
      if (hidText && hasText && mode !== "words") {
        hidText = false;
        void context.setText(true);
      }
      if (mode === "words" || mode === "dictionary") void enterWords(true);
    },
  };
}

export default { createController };

/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The game menu's Text Hooker settings panel, for the controller. In Steam Deck Gaming Mode
 * nothing can point at the sidebar's hooked-text select or the card's own bar, buttons and menu,
 * so they are here instead.
 *
 * At the top, the hooked text, as the sidebar's select shows it (frontend/main/HookControls.tsx):
 * the chosen thread's latest line, or what the hook is doing (starting, downloading, hooking,
 * waiting for text, finding the dialogue) with a spinner, and how the thread was chosen. A on it
 * opens the list of threads (`threads`): Choose automatically, then each thread with its latest
 * text; A picks one (remembered for the game, as in the sidebar), B goes back. It is live: the
 * panel redraws as the hook's status changes (`render`).
 *
 * Below it, the card: whether it shows at all, moving and resizing it with the sticks, Auto align,
 * its text size, its background's opacity and its look. Everything is kept where the card's own
 * controls and Settings → Text Hooker keep it (the game's settings; the overlay's look).
 *
 * The D-pad (or left stick) moves between rows, left and right change a row's value, A switches or
 * opens the selected row (and does nothing on a row with a value to step), B closes. Every change
 * is saved as it is made, so there is nothing to save on the way out. The panel draws and reports;
 * the controller (ui/controller.js) does the rest, through `rows()` and `threads()` for what it
 * shows and the `on…` hooks for a press.
 */

/**
 * How long after opening the panel takes no press: the press that chose it in the menu must not
 * also press the row the panel opens on.
 */
const OPEN_GRACE_MS = 300;

/** The card looks the overlay's style offers (`overlayStyle.appearance`), in the order they cycle. */
export const CARD_LOOKS = [
  { value: "app", label: "Like Kimochi" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "blend", label: "Blend" },
];

/** The next value along `values` from `current`, `step` places on, held at the ends. */
export function stepValue(values, current, step) {
  const at = values.indexOf(current);
  const from = at < 0 ? 0 : at;
  return values[Math.max(0, Math.min(values.length - 1, from + step))];
}

/** The next look along `CARD_LOOKS`, going round. */
export function nextLook(current, step) {
  const at = Math.max(0, CARD_LOOKS.findIndex((look) => look.value === current));
  return CARD_LOOKS[(at + step + CARD_LOOKS.length) % CARD_LOOKS.length].value;
}

/** One line of a thread's text, for a row. */
const firstLine = (text) => String(text ?? "").replace(/\s+/g, " ").trim();
const threadLabel = (thread) => firstLine(thread.preview) || thread.name;

/** How the thread in use was chosen, as the sidebar says it. */
function howChosen(status) {
  if (status.selectedBy === "saved") return "Remembered for this game";
  if (status.selectedBy === "auto") return "Matched to the screen";
  if (status.selectedBy === "manual") return "Chosen by you";
  if (status.pickNote) return "Nothing matches the screen yet";
  return undefined;
}

/**
 * What the hooked-text row shows for a `texthook-status` (HookControls.tsx `shown`): its text,
 * whether the hook is still working on it (`busy`, a spinner) or needs the reader (`warn`), whether
 * its list of threads can be opened, and how the thread was chosen.
 * @returns {{text: string, busy: boolean, warn: boolean, ja: boolean, enabled: boolean, how?: string}}
 */
export function hookSummary(status) {
  const result = (text, extra = {}) => ({ text, busy: false, warn: false, ja: false, enabled: false, ...extra });
  if (!status || status.phase === "idle") return result("Not hooked", { warn: true });
  if (status.phase === "failed" || status.phase === "ended")
    return result(status.detail || (status.phase === "ended" ? "The game has closed." : "The game could not be hooked."), {
      warn: true,
    });
  const engine = status.engine?.name ?? "the hooker";
  if (status.phase === "starting") return result("Starting…", { busy: true });
  if (status.phase === "downloading") {
    const d = status.download;
    const percent = d && d.total > 0 ? Math.floor((d.done / d.total) * 100) : 0;
    return result(`Downloading ${engine}… ${percent}%`, { busy: true });
  }
  if (status.phase === "attaching") return result("Hooking…", { busy: true });
  const threads = status.threads ?? [];
  const selected = threads.find((thread) => thread.selected);
  const how = howChosen(status);
  if (selected) return result(threadLabel(selected), { ja: true, enabled: true, how });
  if (!threads.length) {
    const couldNotHook = (status.hookFailures?.length ?? 0) > 0;
    return couldNotHook ? result("No text hooked", { warn: true }) : result("Waiting for text…", { busy: true });
  }
  if (status.pickNote) return result("Choose the text…", { warn: true, enabled: true, how });
  return result("Finding the dialogue…", { busy: true, enabled: true, how });
}

/**
 * The list A on the hooked text opens (HookControls.tsx's menu): Choose automatically, then every
 * thread with its latest line. `current` marks the choice in force: automatic unless one was
 * chosen by hand; `live` the thread whose text is being used.
 * @returns {{key: string|null, label: string, detail?: string, current: boolean, live: boolean, ja: boolean}[]}
 */
export function threadChoices(status) {
  const threads = status?.threads ?? [];
  const manual = status?.selectedBy === "manual" && threads.some((thread) => thread.selected);
  return [
    {
      key: null,
      label: "Choose automatically",
      detail: manual ? undefined : howChosen(status ?? {}),
      current: !manual,
      live: false,
      ja: false,
    },
    ...threads.map((thread) => ({
      key: thread.key,
      label: threadLabel(thread),
      detail: thread.name,
      current: manual && thread.selected,
      live: thread.selected,
      ja: true,
    })),
  ];
}

const make = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

const SPINNER = '<span class="cm-spinner" aria-hidden="true"></span>';
const WARN =
  '<svg class="cm-card-icon cm-card-warn" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';
const TEXT =
  '<svg class="cm-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7"/><path d="M17 12H7"/></svg>';

export class ControllerCard {
  /**
   * @param {HTMLElement} host
   * @param {{ rows: () => {id: string, label: string, value?: string, kind: 'toggle'|'step'|'action'|'hook', on?: boolean, enabled?: boolean, detail?: string, hook?: ReturnType<typeof hookSummary>}[],
   *           threads: () => ReturnType<typeof threadChoices>,
   *           onActivate: (id: string) => void, onChange: (id: string, step: number) => void,
   *           onPick: (key: string|null) => void, onClose: () => void }} hooks
   */
  constructor(host, hooks) {
    this.host = host;
    this.hooks = hooks;
    this.root = null;
    this.index = 0;
    /** `rows`, or `threads` while the list of threads is open. */
    this.view = "rows";
    this.threadKey = undefined;
  }

  get open() {
    return this.root !== null;
  }

  /** The list of threads is open. */
  get inThreads() {
    return this.root !== null && this.view === "threads";
  }

  /**
   * Opens the panel where it covers the card least: above the middle when the card is in the
   * lower half (where games put their text), below it otherwise.
   * @param {{x: number, y: number, width: number, height: number}|null} card
   */
  show(card) {
    this.remove();
    this.view = "rows";
    const root = make("section", "cm-history cm-card-panel");
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Text Hooker settings");
    const low = !card || card.y + card.height / 2 > window.innerHeight / 2;
    root.style.left = "50%";
    root.style.top = low ? "36%" : "64%";
    const heading = make("header");
    this.title = make("strong", "", "Text Hooker settings");
    heading.append(this.title);
    const close = make("button", "", "Close");
    close.addEventListener("click", () => (this.inThreads ? this.back() : this.hooks.onClose()));
    heading.append(close);
    this.close = close;
    this.list = make("div", "cm-history-content cm-card-rows");
    this.hints = make("footer", "cm-card-hints");
    root.append(heading, this.list, this.hints);
    this.root = root;
    this.openedAt = performance.now();
    this.host.append(root);
    this.render();
  }

  /** Still taking the press that opened the panel. */
  settling() {
    return performance.now() - (this.openedAt ?? 0) < OPEN_GRACE_MS;
  }

  /** Draws what is open as it is now (call after any change, and as the hook's status changes). */
  render() {
    if (!this.root) return;
    if (this.view === "threads") return this.renderThreads();
    const rows = this.hooks.rows();
    this.rows = rows;
    this.index = Math.max(0, Math.min(rows.length - 1, this.index));
    this.title.textContent = "Text Hooker settings";
    this.close.textContent = "Close";
    this.hints.innerHTML =
      '<span class="cm-hint"><kbd class="cm-glyph">✥</kbd>Choose</span>' +
      '<span class="cm-hint"><kbd class="cm-glyph">◀ ▶</kbd>Change</span>' +
      '<span class="cm-hint"><kbd class="cm-glyph cm-confirm">A</kbd>Select</span>' +
      '<span class="cm-hint"><kbd class="cm-glyph cm-cancel">B</kbd>Close</span>';
    this.list.replaceChildren(
      ...rows.map((row, index) => {
        const element = make("button", "cm-history-entry cm-card-row");
        element.setAttribute("aria-current", String(index === this.index));
        if (row.enabled === false) element.dataset.disabled = "";
        element.append(make("span", "cm-card-label", row.label));
        const value = make("span", "cm-card-value");
        if (row.kind === "toggle") {
          value.dataset.on = String(Boolean(row.on));
          value.textContent = row.on ? "On" : "Off";
        } else if (row.kind === "step") {
          value.append(make("i", "cm-card-arrow", "‹"), make("b", "", row.value ?? ""), make("i", "cm-card-arrow", "›"));
        } else value.textContent = row.value ?? "›";
        element.append(value);
        if (row.kind === "hook" && row.hook) element.append(this.hookLine(row.hook));
        if (row.detail) element.append(make("small", "cm-card-detail", row.detail));
        element.addEventListener("click", () => {
          if (this.settling()) return;
          this.index = index;
          this.render();
          this.activate();
        });
        return element;
      }),
    );
    this.list.children[this.index]?.scrollIntoView({ block: "nearest" });
  }

  /** The hooked text's own line: a spinner, a warning or the text mark, then the text. */
  hookLine(hook) {
    const line = make("span", "cm-card-thread");
    if (hook.warn) line.dataset.warn = "";
    if (hook.busy) line.dataset.busy = "";
    const mark = make("span", "cm-card-mark");
    mark.innerHTML = hook.busy ? SPINNER : hook.warn ? WARN : TEXT;
    const text = make("span", "cm-card-thread-text", hook.text);
    if (hook.ja) text.setAttribute("lang", "ja");
    line.append(mark, text);
    return line;
  }

  renderThreads() {
    const choices = this.hooks.threads();
    this.choices = choices;
    // The list follows its thread as the hook's status reorders it.
    if (this.threadKey !== undefined) {
      const at = choices.findIndex((choice) => choice.key === this.threadKey);
      if (at >= 0) this.index = at;
    }
    this.index = Math.max(0, Math.min(choices.length - 1, this.index));
    this.threadKey = choices[this.index]?.key;
    this.title.textContent = "Hooked text";
    this.close.textContent = "Back";
    this.hints.innerHTML =
      '<span class="cm-hint"><kbd class="cm-glyph">✥</kbd>Choose</span>' +
      '<span class="cm-hint"><kbd class="cm-glyph cm-confirm">A</kbd>Use this text</span>' +
      '<span class="cm-hint"><kbd class="cm-glyph cm-cancel">B</kbd>Back</span>';
    this.list.replaceChildren(
      ...choices.map((choice, index) => {
        const element = make("button", "cm-history-entry cm-card-row cm-card-choice");
        element.setAttribute("aria-current", String(index === this.index));
        if (choice.current) element.dataset.current = "";
        if (choice.live) element.dataset.live = "";
        const label = make("span", "cm-card-choice-text", choice.label);
        if (choice.ja) label.setAttribute("lang", "ja");
        element.append(make("span", "cm-card-check", choice.current ? "●" : ""), label);
        if (choice.detail) element.append(make("small", "cm-card-detail", choice.detail));
        element.addEventListener("click", () => {
          this.index = index;
          this.pick();
        });
        return element;
      }),
    );
    this.list.children[this.index]?.scrollIntoView({ block: "nearest" });
  }

  /** Opens the list of threads. */
  openThreads() {
    this.view = "threads";
    this.rowIndex = this.index;
    const choices = this.hooks.threads();
    // On the choice in force: automatic, or the thread chosen by hand.
    this.index = Math.max(0, choices.findIndex((choice) => choice.current));
    this.threadKey = choices[this.index]?.key;
    this.render();
  }

  /** Back from the list of threads to the settings. */
  back() {
    if (this.view !== "threads") return;
    this.view = "rows";
    this.index = this.rowIndex ?? 0;
    this.threadKey = undefined;
    this.render();
  }

  pick() {
    const choice = this.choices?.[this.index];
    if (!choice) return;
    this.hooks.onPick(choice.key);
    this.back();
  }

  /** Up and down choose a row; left and right change its value. */
  direction(dir) {
    if (!this.root) return;
    const count = this.view === "threads" ? (this.choices?.length ?? 0) : (this.rows?.length ?? 0);
    if (!count) return;
    if (dir === "up" || dir === "down") {
      this.index = Math.max(0, Math.min(count - 1, this.index + (dir === "up" ? -1 : 1)));
      if (this.view === "threads") this.threadKey = this.choices[this.index]?.key;
      this.render();
      return;
    }
    if (this.view === "threads") return;
    const row = this.rows[this.index];
    if (!row || this.settling()) return;
    if (row.kind !== "step" && row.kind !== "toggle") return;
    if (row.enabled === false) return this.refuse();
    this.hooks.onChange(row.id, dir === "left" ? -1 : 1);
  }

  /** A on the selected row: switch it, or open what it opens. Nothing on a row with a value to step. */
  activate() {
    if (this.settling()) return;
    if (this.view === "threads") return this.pick();
    const row = this.rows?.[this.index];
    if (!row || row.kind === "step") return;
    if (row.enabled === false) return this.refuse();
    if (row.kind === "hook") return this.openThreads();
    this.hooks.onActivate(row.id);
  }

  /** A shake: that row cannot be changed now. */
  refuse() {
    const element = this.list?.children[this.index];
    if (!element) return;
    element.classList.remove("cm-refuse");
    void element.offsetWidth;
    element.classList.add("cm-refuse");
  }

  hide() {
    if (this.root) this.root.hidden = true;
  }

  reveal() {
    if (!this.root) return;
    this.root.hidden = false;
    this.render();
  }

  bounds() {
    return this.root && !this.root.hidden ? this.root.getBoundingClientRect() : null;
  }

  remove() {
    this.root?.remove();
    this.root = null;
    this.view = "rows";
  }
}

export default { ControllerCard, CARD_LOOKS, stepValue, nextLook, hookSummary, threadChoices };

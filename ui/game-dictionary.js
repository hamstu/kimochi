/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The full-screen dictionary: Read along's other look.
 *
 * Instead of an outline on the game's text and the dictionary's pop-up beside it, the whole scan
 * is set out across the top of a dimmed screen, one word lit, and that word's dictionary fills
 * the space below a rule. The D-pad (or the arrow keys) moves the lit word along and the
 * dictionary follows.
 *
 * What fills that space depends on the engine. With the Yomitan API (the `entries` source) it is
 * Kimochi's own drawing of the raw entries (`/tokenize` for the words, `/ankiFields` for the
 * entries): the shoulder buttons step between the entries a word has, A adds the entry to Anki
 * through Kimochi's own Add to Anki settings, the right stick scrolls a long entry. Every other
 * engine (built-in Yomitan, Hachidori, 10ten) draws its own pop-up (the `popup` source): the view
 * looks the lit word up in the engine through `context.lookupInPopup`, handing it the lit word's
 * range in this view and the rectangle of the space below the rule (`slotRect`), and the overlay
 * places the engine's pop-up over that rectangle. The controller drives the pop-up as in popup
 * mode (ui/controller.js).
 *
 * The view owns nothing native: the controller (ui/controller.js) feeds it its commands, and the
 * overlay (ui/overlay.js) the lookups, Anki and audio through `context`. Its colours, type and
 * spacing are custom properties on `.gd-root` (ui/game-dictionary.css), so a restyle of the
 * controller's surfaces can restyle it too.
 */

/** How far one press of up or down scrolls the entry, in points. */
const SCROLL_STEP = 120;
/** How much text a pop-up lookup starts from the lit word: as word-nav.js's `SCAN_LENGTH`. */
const POPUP_SCAN_LENGTH = 16;

// --- the text and its words (pure, tested in scripts/game-dictionary.test.mjs) ------------------

/**
 * The scan as one run of text for the top of the screen, with every word the reader can stop on.
 *
 * `units` are the controller's segmented boxes in reading order (`segmentAcross` in word-nav.js):
 * a token may start in one box and run on into the next, whose text it covers is then no token of
 * its own. Boxes are joined with nothing between them: a dialogue box's two lines are one
 * sentence. Text no token covers (punctuation, a gap the dictionary matched nothing in) is kept as
 * a filler token that is not a stop, so the whole scan is drawn. Each token keeps the unit it
 * starts in (`unit`) and that unit's box (`box`: the first unit drawn by the same overlay
 * `element`, since a block's lines or a bubble's columns are units of one box). The view draws
 * each unit as its own line (`sentenceLines`).
 *
 * @param {{text: string, element?: object, tokens: {start: number, end: number, text: string, word: boolean}[]}[]} units
 * @returns {{text: string, tokens: {start: number, end: number, text: string, word: boolean, unit: number, box: number}[]}}
 */
export function sentenceTokens(units) {
  const offsets = [];
  let text = "";
  for (const unit of units) {
    offsets.push(text.length);
    text += unit.text;
  }
  const unitAt = (offset) => {
    let unit = 0;
    while (unit + 1 < offsets.length && offsets[unit + 1] <= offset) unit++;
    return unit;
  };
  const found = [];
  units.forEach((unit, index) => {
    for (const token of unit.tokens ?? []) {
      const start = offsets[index] + token.start;
      const end = Math.min(text.length, offsets[index] + token.end);
      if (end > start) found.push({ start, end, word: Boolean(token.word), unit: index });
    }
  });
  found.sort((a, b) => a.start - b.start);
  const tokens = [];
  let at = 0;
  // A gap is split where a box starts, so every token lies in the box it is drawn with.
  const filler = (end) => {
    while (end > at) {
      const unit = unitAt(at);
      const stop = Math.min(end, offsets[unit + 1] ?? end);
      tokens.push({ start: at, end: stop, text: text.slice(at, stop), word: false, unit });
      at = stop;
    }
  };
  for (const token of found) {
    if (token.start < at) continue; // covered by a token that ran on past its box
    filler(token.start);
    tokens.push({ ...token, text: text.slice(token.start, token.end) });
    at = token.end;
  }
  filler(text.length);
  const boxes = [];
  units.forEach((unit, index) => {
    const same = index > 0 && unit.element && unit.element === units[index - 1].element;
    boxes.push(same ? boxes[index - 1] : index);
  });
  for (const token of tokens) token.box = boxes[token.unit];
  return { text, tokens };
}

/** The next stop from token `index` by `delta` words, or `index` when there is none that way. */
export function nextWord(tokens, index, delta) {
  for (let at = index + delta; at >= 0 && at < tokens.length; at += delta) {
    if (tokens[at].word) return at;
  }
  return index;
}

/** The first stop in the text, or -1 when it has none. */
export function firstWord(tokens) {
  return tokens.findIndex((token) => token.word);
}

/**
 * The scan as the Log shows it: each unit (a scanned line, or a box's own line) one line of plain
 * text, stacked, with the tokens' boundaries kept only as spans inside it. A token that runs on
 * from one unit into the next is split at the break, each piece carrying the token's `index`, so
 * lighting the word lights both. Units with no text leave no line.
 *
 * @returns {{text: string, tokens: object[], lines: {text: string, index: number, word: boolean}[][]}}
 */
export function sentenceLines(units) {
  const { text, tokens } = sentenceTokens(units);
  const offsets = [];
  let at = 0;
  for (const unit of units) {
    offsets.push(at);
    at += unit.text.length;
  }
  const lines = units.map(() => []);
  tokens.forEach((token, index) => {
    for (let unit = token.unit; unit < units.length; unit++) {
      const end = offsets[unit] + units[unit].text.length;
      const from = Math.max(token.start, offsets[unit]);
      const to = Math.min(token.end, end);
      if (to > from) lines[unit].push({ text: text.slice(from, to), index, word: token.word });
      if (end >= token.end) break;
    }
  });
  return { text, tokens, lines: lines.filter((line) => line.length > 0) };
}

/**
 * How much smaller than its full size the scanned text is set, for `chars` characters on `lines`
 * lines: a line or two stays large, a long scan steps down so more of it shows at once. The CSS
 * keeps a floor under it (`.gd-sentence`), so it never gets too small to read.
 */
export function sentenceScale(chars, lines = 1) {
  let scale = chars <= 30 ? 1 : chars <= 60 ? 0.85 : chars <= 110 ? 0.72 : chars <= 180 ? 0.62 : 0.54;
  if (lines >= 3) scale = Math.min(scale, 0.85);
  if (lines >= 5) scale = Math.min(scale, 0.72);
  if (lines >= 8) scale = Math.min(scale, 0.62);
  return scale;
}

/** Whether a scroller has more above and below what shows, for its edge fades. */
export function edgeFades(scrollTop, clientHeight, scrollHeight) {
  return { above: scrollTop > 1, below: scrollTop + clientHeight < scrollHeight - 1 };
}

/**
 * Where a scroller showing `view` ({scrollTop, clientHeight}) must scroll so the span from `top`
 * to `bottom` (content coordinates) shows clear of `margin` at each edge (where the fades are);
 * null when it already does. A span taller than the room left is shown from its top.
 */
export function scrollToShow(top, bottom, view, margin = 0) {
  const { scrollTop, clientHeight } = view;
  const room = clientHeight - margin * 2;
  if (bottom - top > room || top - margin < scrollTop) {
    const next = Math.max(0, top - margin);
    return next === scrollTop ? null : next;
  }
  if (bottom + margin > scrollTop + clientHeight) return bottom + margin - clientHeight;
  return null;
}

/** The file names an entry's `audio` field plays (`[sound:a.mp3]`), so its media can be found. */
export function soundFiles(fields) {
  return [...String(fields?.audio ?? "").matchAll(/\[sound:([^\]]+)\]/g)].map((match) => match[1]);
}

/** The audio item an entry plays, from a lookup's `audioMedia`; null when it has none. */
export function entryAudio(fields, audioMedia) {
  const files = soundFiles(fields);
  return (audioMedia ?? []).find((item) => files.includes(item.ankiFilename)) ?? null;
}

const AUDIO_TYPES = { mp3: "audio/mpeg", ogg: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac" };

/** A media item as a `data:` URL an `<audio>` can play. */
export function audioUrl(item) {
  const extension = /\.([a-z0-9]+)$/i.exec(item.ankiFilename)?.[1]?.toLowerCase() ?? "mp3";
  return `data:${AUDIO_TYPES[extension] ?? "audio/mpeg"};base64,${item.contentBase64 ?? item.content}`;
}

/** Yomitan's comma-separated tags, as the pop-up shows them (`Unknown` is none). */
export function splitTags(value) {
  if (!value || value === "Unknown") return [];
  return String(value)
    .split(/[,\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

/**
 * Inflection chains from Yomitan's `conjugation` marker: `«`-separated rules per chain, chains one
 * per line or list item. Only the rule names: the pop-up's descriptions need its tooltips.
 */
export function inflectionChains(value) {
  if (!value) return [];
  const text = String(value)
    .replace(/<\/li>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  return text
    .split("\n")
    .map((line) => line.split("«").map((rule) => rule.trim()).filter(Boolean))
    .filter((chain) => chain.length > 0);
}

// --- glossary HTML -------------------------------------------------------------------------------

/** What a glossary may keep: Yomitan's structured content, nothing that runs or loads. */
const ALLOWED_TAGS = new Set([
  "A", "B", "BR", "DIV", "EM", "I", "LI", "OL", "P", "RP", "RT", "RUBY", "S", "SMALL", "SPAN",
  "STRONG", "SUB", "SUP", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "U", "UL", "DETAILS",
  "SUMMARY"
]);
const ALLOWED_ATTRIBUTES = new Set(["class", "lang", "style", "title", "colspan", "rowspan"]);

/**
 * Dictionary HTML as display data: the Log's pop-up passes it through DOMPurify, which the
 * overlay (plain ES modules, no bundler) cannot load, so this keeps an allowlist of tags and
 * attributes and unwraps everything else to its text. Links keep only Yomitan's in-dictionary
 * `href="#"`; styles lose anything that could load a URL.
 */
export function sanitizeGlossary(html, doc = document) {
  const template = doc.createElement("template");
  template.innerHTML = String(html ?? "");
  const clean = (node) => {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1) {
        child.remove();
        continue;
      }
      if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "IMG", "SVG", "MATH", "TEMPLATE", "LINK", "META"].includes(child.tagName.toUpperCase())) {
        child.remove();
        continue;
      }
      clean(child);
      if (!ALLOWED_TAGS.has(child.tagName.toUpperCase())) {
        child.replaceWith(...child.childNodes);
        continue;
      }
      for (const attribute of [...child.attributes]) {
        const name = attribute.name.toLowerCase();
        const keep =
          ALLOWED_ATTRIBUTES.has(name) ||
          name.startsWith("data-sc") ||
          (name === "href" && attribute.value === "#");
        if (!keep || (name === "style" && /url\s*\(|expression\s*\(|@import/i.test(attribute.value)))
          child.removeAttribute(attribute.name);
      }
    }
  };
  clean(template.content);
  return template.content;
}

// --- the view ------------------------------------------------------------------------------------

const escapeHtml = (text) =>
  String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** One hint on the bar: its key or button, and what it does; nothing for an unbound button. */
function hint(glyph, label, { tone = "", action = "" } = {}) {
  if (!glyph) return "";
  const kbd = `<kbd class="cm-glyph${tone ? ` cm-${tone}` : ""}">${escapeHtml(glyph)}</kbd>`;
  return action
    ? `<button type="button" class="cm-hint gd-hint" data-action="${action}">${kbd}<span>${escapeHtml(label)}</span></button>`
    : `<span class="cm-hint gd-hint">${kbd}<span>${escapeHtml(label)}</span></span>`;
}

/** What Add to Anki says in each state, and whether it can be pressed. */
const ANKI_LABELS = {
  off: "Add to Anki",
  checking: "Checking Anki…",
  idle: "Add to Anki",
  sending: "Adding…",
  sent: "Added to Anki",
  duplicate: "In Anki",
  error: "Try again"
};

/**
 * @typedef {object} GameDictionaryContext
 * @property {(term: string, options?: {media?: boolean, maxEntries?: number}) => Promise<{entries: object[], audioMedia: object[], dictionaryMedia: object[]}>} lookup
 *   the Yomitan API's `/ankiFields` for `term`, every entry longest match first
 * @property {() => ({exists: (fields: object, sentence: string) => Promise<number|null>, add: (entry: {fields: object, audioMedia: object[], dictionaryMedia: object[]}, sentence: string) => Promise<{noteId: number, duplicate: boolean}>, open: (noteId: number) => Promise<void>}|null)} anki
 *   Kimochi's Add to Anki, or null until Settings → Anki has a deck, a note type and its fields
 * @property {(item: {ankiFilename: string, contentBase64: string}) => void} play play a word's audio
 * @property {(action: string) => string|null} glyph a bound action's button as drawn; null when unbound
 * @property {() => 'pad'|'keys'} input how the mode was opened, so the hints name the right keys
 * @property {() => void} onClose the view's own Back (a click on it)
 * @property {(record: object) => void} [log]
 * @property {(range: Range, rect: {x: number, y: number, width: number, height: number}) => Promise<boolean>} [lookupInPopup]
 *   the `popup` source: look `range` up in the engine and place its pop-up over `rect` (overlay
 *   points); resolves whether a pop-up is showing for it
 * @property {() => boolean} [popupFocusable] the `popup` source: whether A can move into the
 *   engine pop-up's buttons
 */

/**
 * The text a pop-up lookup reads from word `index` on: its own span and the spans after it, up to
 * `length` characters, as the {node, offset} ends of a Range. A dictionary finds the longest match
 * from there itself (作った, not 作), as it does on the game's text. Null for a word with no text.
 *
 * @param {{firstChild: {nodeType: number, length: number}|null}[]} spans the sentence's spans in order
 * @param {number} from the lit word's span
 */
export function lookupSpan(spans, from, length = POPUP_SCAN_LENGTH) {
  const text = (span) => (span?.firstChild?.nodeType === 3 ? span.firstChild : null);
  const first = text(spans[from]);
  if (!first) return null;
  let end = { node: first, offset: Math.min(first.length, length) };
  let remaining = length - end.offset;
  for (let at = from + 1; at < spans.length && remaining > 0; at++) {
    const node = text(spans[at]);
    if (!node) continue;
    const take = Math.min(node.length, remaining);
    end = { node, offset: take };
    remaining -= take;
  }
  return { start: { node: first, offset: 0 }, end };
}

export class GameDictionary {
  /** @param {HTMLElement} host @param {GameDictionaryContext} context */
  constructor(host, context) {
    this.host = host;
    this.context = context;
    this.root = null;
    this.tokens = [];
    this.text = "";
    this.index = -1;
    /** The lit word's lookup: its term, its entries, which one is shown, and its Anki state. */
    this.result = null;
    this.entry = 0;
    this.anki = "off";
    this.noteId = null;
    /** Bumped on every move, so a lookup that answers late cannot replace a newer word's entry. */
    this.ticket = 0;
    this.cache = new Map();
    /** What fills the space below the text (see `show`), and where the controller is in it. */
    this.source = "entries";
    this.layer = "text";
    this.sectioned = false;
  }

  get open() {
    return Boolean(this.root);
  }

  /**
   * Lay out `units` (the controller's segmented boxes) and look up their first word. `source` is
   * what fills the space below the text: `entries` (the Yomitan API's, drawn here) or `popup` (the
   * engine's own pop-up, placed there by the overlay). With `sections`, each unit is a separately
   * detected section of the scan (the Log's "1 / 2", "2 / 2"): two or more are numbered, and a
   * lookup reads on only to the end of its own section.
   */
  show(units, { title = "", source = "entries", sections = false } = {}) {
    this.remove();
    this.sectioned = Boolean(sections);
    this.source = source === "popup" ? "popup" : "entries";
    this.layer = "text";
    const { text, tokens, lines } = sentenceLines(units);
    this.text = text;
    this.tokens = tokens;
    this.index = firstWord(tokens);
    const root = document.createElement("section");
    root.className = "gd-root";
    root.dataset.source = this.source;
    // macOS keeps its blur of the game behind only while the overlay's layers are being redrawn;
    // the backdrop holds a redraw going there (see `.gd-root[data-os="macos"] .gd-backdrop`).
    root.dataset.os = globalThis.__KIMOCHI_PLATFORM__?.os ?? "";
    root.style.setProperty("--gd-sentence-scale", String(sentenceScale(text.length, lines.length)));
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Dictionary");
    root.innerHTML = `
      <div class="gd-backdrop"></div>
      <div class="gd-frame">
        <header class="gd-head">
          <span class="gd-eyebrow">${escapeHtml(title || "Read along")}</span>
          <span class="gd-count" aria-live="polite"></span>
        </header>
        <div class="gd-sentence" lang="ja"></div>
        <div class="gd-rule" aria-hidden="true"><span class="gd-rule-mark"></span></div>
        <div class="gd-body" tabindex="-1"><article class="gd-entry"></article></div>
        <footer class="gd-bar"></footer>
      </div>`;
    const sentence = root.querySelector(".gd-sentence");
    // The text exactly as the Log has it, a line per section (or per scanned line); words are only
    // spans inside it. Two or more sections are numbered: a mark, not a control.
    const numbered = this.sectioned && lines.length > 1;
    sentence.classList.toggle("gd-numbered", numbered);
    lines.forEach((pieces, number) => {
      const line = document.createElement("div");
      line.className = "gd-line";
      let holder = line;
      if (numbered) {
        const mark = document.createElement("span");
        mark.className = "gd-section-mark";
        mark.setAttribute("aria-hidden", "true");
        const disc = document.createElement("span");
        disc.textContent = String(number + 1);
        mark.append(disc);
        holder = document.createElement("span");
        holder.className = "gd-line-text";
        line.append(mark, holder);
      }
      for (const piece of pieces) {
        const span = document.createElement("span");
        span.textContent = piece.text;
        span.className = piece.word ? "gd-word" : "gd-gap";
        if (piece.word) {
          span.dataset.index = String(piece.index);
          span.addEventListener("click", () => this.select(piece.index));
        }
        holder.append(span);
      }
      sentence.append(line);
    });
    sentence.addEventListener("scroll", () => this.updateFades(), { passive: true });
    root.addEventListener("click", (event) => {
      const action = event.target?.closest?.("[data-action]")?.dataset.action;
      if (action === "close") this.context.onClose();
      else if (action === "anki") void this.confirm();
      else if (action === "audio") void this.audio();
      else if (action === "entry") this.setEntry(Number(event.target.closest("[data-entry]").dataset.entry));
    });
    this.root = root;
    this.host.append(root);
    this.updateFades();
    if (this.index < 0) {
      this.renderEntry({ kind: "empty", message: "No words to look up in this text." });
      this.renderBar();
      return;
    }
    this.select(this.index);
  }

  /** Light word `index` and look it up. */
  select(index) {
    if (!this.root || !this.tokens[index]?.word) return;
    this.index = index;
    for (const span of this.root.querySelectorAll(".gd-word")) {
      const lit = Number(span.dataset.index) === index;
      span.classList.toggle("gd-lit", lit);
      if (lit) span.setAttribute("aria-current", "true");
      else span.removeAttribute("aria-current");
    }
    this.showLit();
    const position = this.tokens.slice(0, index + 1).filter((token) => token.word).length;
    const total = this.tokens.filter((token) => token.word).length;
    this.root.querySelector(".gd-count").textContent = `${position} / ${total}`;
    if (this.source === "popup") void this.lookUpInPopup(index);
    else void this.lookUp(this.tokens[index].text);
  }

  /** Scroll the text, inside its own area, so the lit word shows clear of the edge fades. */
  showLit() {
    const sentence = this.root?.querySelector(".gd-sentence");
    const pieces = [...(this.root?.querySelectorAll(".gd-lit") ?? [])];
    if (!sentence || !pieces.length) return;
    const box = sentence.getBoundingClientRect();
    const rects = pieces.map((piece) => piece.getBoundingClientRect());
    const top = Math.min(...rects.map((rect) => rect.top)) - box.top + sentence.scrollTop;
    const bottom = Math.max(...rects.map((rect) => rect.bottom)) - box.top + sentence.scrollTop;
    const margin = Number.parseFloat(getComputedStyle(sentence).fontSize) * 0.9 || 0;
    const next = scrollToShow(top, bottom, sentence, margin);
    if (next !== null) sentence.scrollTo({ top: next, behavior: "smooth" });
    this.updateFades();
  }

  /** Fade the text's top or bottom edge while there is more of it that way. */
  updateFades() {
    const sentence = this.root?.querySelector(".gd-sentence");
    if (!sentence) return;
    const { above, below } = edgeFades(sentence.scrollTop, sentence.clientHeight, sentence.scrollHeight);
    sentence.toggleAttribute("data-more-above", above);
    sentence.toggleAttribute("data-more-below", below);
  }

  /** The `popup` source: the space below the rule, in overlay points, for the engine's pop-up. */
  slotRect() {
    const rect = this.root?.querySelector(".gd-body")?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }

  /** The `popup` source: the Range a lookup of word `index` reads, from it on. */
  wordRange(index) {
    const lit = this.root?.querySelector(`.gd-sentence .gd-word[data-index="${index}"]`);
    // A section is read on its own: a lookup does not run on into the next detected section.
    const scope = this.sectioned ? lit?.closest(".gd-line") : this.root?.querySelector(".gd-sentence");
    const spans = [...(scope?.querySelectorAll(".gd-word, .gd-gap") ?? [])];
    const from = spans.findIndex((span) => span.dataset.index === String(index));
    const ends = lookupSpan(spans, from);
    if (!ends) return null;
    const range = document.createRange();
    range.setStart(ends.start.node, ends.start.offset);
    range.setEnd(ends.end.node, ends.end.offset);
    return range;
  }

  /** The `popup` source: look word `index` up in the engine, its pop-up over the space below. */
  async lookUpInPopup(index) {
    const ticket = ++this.ticket;
    const term = this.tokens[index].text;
    this.layer = "text";
    this.result = null;
    this.renderEntry({ kind: "popup", term });
    this.renderBar();
    const range = this.wordRange(index);
    const rect = this.slotRect();
    let shown = false;
    try {
      shown = Boolean(range && rect && (await this.context.lookupInPopup?.(range, rect)));
    } catch (error) {
      this.context.log?.({ check: "game-dictionary-popup-lookup-failed", error: String(error?.message ?? error) });
    }
    if (ticket !== this.ticket || !this.root) return;
    // Under the pop-up while it shows; in view when no dictionary had anything for the word.
    if (!shown) this.renderEntry({ kind: "empty", term });
  }

  /** The `popup` source: whether A, the D-pad and B are in the engine pop-up's buttons. */
  setLayer(layer) {
    this.layer = layer === "popup" ? "popup" : "text";
    this.renderBar();
  }

  async lookUp(term) {
    const ticket = ++this.ticket;
    this.result = null;
    this.entry = 0;
    this.noteId = null;
    this.anki = this.context.anki() ? "checking" : "off";
    let entries = this.cache.get(term);
    if (!entries) {
      this.renderEntry({ kind: "loading", term });
      this.renderBar();
      try {
        entries = (await this.context.lookup(term)).entries ?? [];
        this.cache.set(term, entries);
      } catch (error) {
        if (ticket !== this.ticket) return;
        this.context.log?.({ check: "game-dictionary-lookup-failed", error: String(error?.message ?? error) });
        this.anki = "off";
        this.renderEntry({ kind: "error", term, message: String(error?.message ?? error) });
        this.renderBar();
        return;
      }
      if (ticket !== this.ticket) return;
    }
    this.result = { term, entries };
    if (!entries.length) this.anki = "off";
    this.renderEntry(entries.length ? { kind: "entry" } : { kind: "empty", term });
    this.renderBar();
    void this.checkAnki(ticket);
  }

  /** Whether the shown entry is already in the deck, before offering to add it. */
  async checkAnki(ticket = this.ticket) {
    const anki = this.context.anki();
    const fields = this.result?.entries[this.entry];
    if (!anki || !fields) return;
    this.anki = "checking";
    this.renderBar();
    let noteId = null;
    try {
      noteId = await anki.exists(fields, this.text);
    } catch {
      // Anki not answering: offer the button anyway, the add says what is wrong.
    }
    if (ticket !== this.ticket) return;
    this.noteId = noteId;
    this.anki = noteId !== null ? "duplicate" : "idle";
    this.renderBar();
  }

  /** Show entry `entry` of the lit word's lookup. */
  setEntry(entry) {
    const count = this.result?.entries.length ?? 0;
    if (!count) return false;
    const next = Math.max(0, Math.min(count - 1, entry));
    if (next === this.entry) return false;
    this.entry = next;
    this.ticket++;
    this.noteId = null;
    this.renderEntry({ kind: "entry" });
    void this.checkAnki();
    return true;
  }

  // --- commands from the controller -------------------------------------------------------------

  /** ← → step words; ↑ ↓ scroll the entry. False when there was nowhere to go (for a bump). */
  move(dir) {
    if (dir === "up" || dir === "down") {
      this.scroll(dir === "up" ? -SCROLL_STEP : SCROLL_STEP, true);
      return true;
    }
    const next = nextWord(this.tokens, this.index, dir === "left" ? -1 : 1);
    if (next === this.index) {
      this.bump();
      return false;
    }
    this.select(next);
    return true;
  }

  /** LB / RB: the previous or next entry for this word. */
  step(delta) {
    if (!this.setEntry(this.entry + delta)) this.bump();
  }

  scroll(points, smooth = false) {
    this.root?.querySelector(".gd-body")?.scrollBy({ top: points, behavior: smooth ? "smooth" : "auto" });
  }

  /** A: add the shown entry to Anki, or open it there once it is in. */
  async confirm() {
    const anki = this.context.anki();
    const fields = this.result?.entries[this.entry];
    if (!anki || !fields || this.anki === "sending" || this.anki === "checking") return this.bump();
    if ((this.anki === "sent" || this.anki === "duplicate") && this.noteId !== null) {
      try {
        await anki.open(this.noteId);
      } catch (error) {
        this.context.log?.({ check: "game-dictionary-anki-open-failed", error: String(error?.message ?? error) });
      }
      return;
    }
    const ticket = this.ticket;
    const entry = this.entry;
    this.anki = "sending";
    this.renderBar();
    try {
      // With media: the entry's audio and images go on the card. Only as many entries as it takes
      // to reach this one, since Yomitan fetches each returned entry's audio in turn.
      const media = await this.context.lookup(this.result.term, { media: true, maxEntries: entry + 1 });
      const withMedia = media.entries[entry] ?? fields;
      const result = await anki.add(
        { fields: withMedia, audioMedia: media.audioMedia ?? [], dictionaryMedia: media.dictionaryMedia ?? [] },
        this.text,
      );
      if (ticket !== this.ticket) return;
      this.noteId = result.noteId;
      this.anki = result.duplicate ? "duplicate" : "sent";
      this.context.log?.({ check: "game-dictionary-anki", duplicate: result.duplicate });
    } catch (error) {
      if (ticket !== this.ticket) return;
      this.anki = "error";
      this.ankiError = /unreachable|not answering/i.test(String(error)) ? "Anki is not running" : String(error?.message ?? error);
    }
    this.renderBar();
  }

  /** X: play the shown entry's audio. */
  async audio() {
    const fields = this.result?.entries[this.entry];
    if (!fields) return this.bump();
    try {
      const media = await this.context.lookup(this.result.term, { media: true, maxEntries: this.entry + 1 });
      const item = entryAudio(media.entries[this.entry] ?? fields, media.audioMedia) ?? media.audioMedia?.[0];
      if (!item) return this.bump();
      this.context.play(item);
    } catch {
      this.bump();
    }
  }

  /** Redraw the hints, as the input or the bound buttons changed. */
  refresh() {
    this.renderBar();
  }

  bump() {
    const frame = this.root?.querySelector(".gd-frame");
    if (!frame) return;
    frame.classList.remove("gd-bump");
    void frame.offsetWidth;
    frame.classList.add("gd-bump");
  }

  remove() {
    this.ticket++;
    const leaving = this.root;
    this.root = null;
    this.result = null;
    if (!leaving) return;
    leaving.classList.add("gd-leaving");
    setTimeout(() => leaving.remove(), 200);
  }

  /** The whole screen while open: the overlay takes clicks there, so words and buttons work by mouse. */
  bounds() {
    return this.root ? { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight } : null;
  }

  // --- drawing ----------------------------------------------------------------------------------

  renderEntry(state) {
    const article = this.root?.querySelector(".gd-entry");
    if (!article) return;
    const body = this.root.querySelector(".gd-body");
    body.scrollTop = 0;
    article.dataset.state = state.kind;
    if (state.kind === "popup") {
      article.innerHTML = `<p class="gd-status"><span class="gd-spinner" aria-hidden="true"></span>Looking up <span lang="ja">${escapeHtml(state.term)}</span>…</p>`;
      return;
    }
    if (state.kind === "loading") {
      article.innerHTML = `<p class="gd-status"><span class="gd-spinner" aria-hidden="true"></span>Looking up <span lang="ja">${escapeHtml(state.term)}</span>…</p>`;
      return;
    }
    if (state.kind === "error") {
      article.innerHTML = `<p class="gd-status gd-status-error"><b>The Yomitan API did not answer.</b> ${escapeHtml(state.message ?? "")}</p>`;
      return;
    }
    if (state.kind === "empty") {
      article.innerHTML = state.term
        ? `<p class="gd-status">No dictionary has an entry for <span lang="ja">${escapeHtml(state.term)}</span>.</p>`
        : `<p class="gd-status">${escapeHtml(state.message ?? "")}</p>`;
      return;
    }
    const { entries } = this.result;
    const fields = entries[this.entry];
    const expression = fields.expression || this.result.term;
    const reading = fields.reading && fields.reading !== expression ? fields.reading : "";
    const chains = inflectionChains(fields.conjugation);
    const badges = [
      ...(fields.dictionary && fields.dictionary !== "Unknown" ? [`<span class="gd-badge gd-badge-dict">${escapeHtml(fields.dictionary)}</span>`] : []),
      ...splitTags(fields["part-of-speech"]).map((tag) => `<span class="gd-badge">${escapeHtml(tag)}</span>`),
      ...splitTags(fields.tags).map((tag) => `<span class="gd-badge">${escapeHtml(tag)}</span>`)
    ];
    // The other entries a word has, by their headwords: the shoulder buttons move along these.
    const others =
      entries.length > 1
        ? `<nav class="gd-entries" aria-label="Entries">${entries
            .map(
              (entry, index) =>
                `<button type="button" class="gd-entry-tab${index === this.entry ? " gd-entry-current" : ""}" data-action="entry" data-entry="${index}" lang="ja">${escapeHtml(entry.expression || this.result.term)}${entry.reading && entry.reading !== entry.expression ? `<small>${escapeHtml(entry.reading)}</small>` : ""}</button>`,
            )
            .join("")}</nav>`
        : "";
    article.innerHTML = `
      ${others}
      <header class="gd-headword">
        <span class="gd-expression" lang="ja">${escapeHtml(expression)}</span>
        ${reading ? `<span class="gd-reading" lang="ja">${escapeHtml(reading)}</span>` : ""}
      </header>
      ${chains.length ? `<p class="gd-inflection"><span class="gd-label">Inflected</span>${chains.map((chain) => chain.map((rule) => `<span class="gd-badge">${escapeHtml(rule)}</span>`).join('<span class="gd-sep">«</span>')).join('<span class="gd-label">or</span>')}</p>` : ""}
      ${badges.length ? `<p class="gd-badges">${badges.join("")}</p>` : ""}
      <div class="gd-glossary yomitan-html"></div>
      ${fields.frequencies ? `<div class="gd-frequencies yomitan-html"></div>` : ""}`;
    article.querySelector(".gd-glossary").append(sanitizeGlossary(fields.glossary));
    article.querySelector(".gd-frequencies")?.append(sanitizeGlossary(fields.frequencies));
    article.querySelector(".gd-entry-current")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  /** The `popup` source's hints: the engine's pop-up does the rest, as in popup mode. */
  popupHints() {
    const keys = this.context.input() === "keys";
    const glyph = this.context.glyph;
    const pair = [glyph("previousDefinition"), glyph("nextDefinition")].filter(Boolean).join(" ");
    if (this.layer === "popup") {
      return `
      <span class="gd-bar-group">
        ${hint(keys ? "← ↑ ↓ →" : "D-pad", "Choose")}
        ${hint(keys ? "return" : glyph("confirm"), "Press", { tone: "confirm" })}
        ${keys ? "" : hint(pair, "Entry")}
      </span>
      <span class="gd-bar-group gd-bar-actions">
        ${hint(keys ? "esc" : glyph("back"), "Back to text", { tone: "cancel" })}
      </span>`;
    }
    const focusable = Boolean(this.context.popupFocusable?.());
    return `
      <span class="gd-bar-group">
        ${hint(keys ? "← →" : "◀ ▶", "Word")}
        ${keys ? "" : hint(pair, "Entry")}
        ${hint(keys ? "↑ ↓" : "RS", "Scroll")}
      </span>
      <span class="gd-bar-group gd-bar-actions">
        ${focusable ? hint(keys ? "return" : glyph("confirm"), "Pop-up", { tone: "confirm" }) : ""}
        ${keys ? "" : hint(glyph("playAudio"), "Audio")}
        ${hint(keys ? "esc" : glyph("back"), "Back to game", { tone: "cancel", action: "close" })}
      </span>`;
  }

  renderBar() {
    const bar = this.root?.querySelector(".gd-bar");
    if (!bar) return;
    if (this.source === "popup") return void (bar.innerHTML = this.popupHints());
    const keys = this.context.input() === "keys";
    const glyph = this.context.glyph;
    const entries = this.result?.entries.length ?? 0;
    const anki = this.context.anki() ? this.anki : "off";
    const ankiTone = anki === "sent" || anki === "duplicate" ? "ok" : anki === "error" ? "danger" : "";
    const ankiLabel = anki === "error" && this.ankiError ? `${this.ankiError}. Try again` : ANKI_LABELS[anki];
    const pair = [glyph("previousDefinition"), glyph("nextDefinition")].filter(Boolean).join(" ");
    bar.innerHTML = `
      <span class="gd-bar-group">
        ${hint(keys ? "← →" : "◀ ▶", "Word")}
        ${entries > 1 ? hint(keys ? "" : pair, `Entry ${this.entry + 1} / ${entries}`) : ""}
        ${hint(keys ? "↑ ↓" : "RS", "Scroll")}
      </span>
      <span class="gd-bar-group gd-bar-actions">
        ${this.context.anki() ? `<span class="gd-anki" data-state="${anki}" data-tone="${ankiTone}">${hint(keys ? "return" : glyph("confirm"), ankiLabel, { tone: "confirm", action: "anki" })}</span>` : `<span class="gd-anki" data-state="off">${hint("", "")}<span class="gd-note">Add to Anki: set up in Settings → Anki</span></span>`}
        ${keys ? "" : hint(glyph("playAudio"), "Audio", { action: "audio" })}
        ${hint(keys ? "esc" : glyph("back"), "Back to game", { tone: "cancel", action: "close" })}
      </span>`;
  }
}

export default {
  GameDictionary,
  sentenceTokens,
  sentenceLines,
  sentenceScale,
  edgeFades,
  scrollToShow,
  nextWord,
  firstWord,
  sanitizeGlossary,
  entryAudio,
  lookupSpan,
};

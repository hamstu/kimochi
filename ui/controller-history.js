/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/** A read-only view of durable scan history. Opening old text never republishes OCR. */
export function historyEntries(value) {
  const seen = new Set();
  return (Array.isArray(value) ? value : [])
    .filter((entry) => {
      if (
        !entry ||
        typeof entry.id !== "string" ||
        typeof entry.text !== "string" ||
        !entry.text.trim() ||
        seen.has(entry.id)
      )
        return false;
      seen.add(entry.id);
      return true;
    })
    .slice(0, 50);
}

export function historyIndex(index, direction, count) {
  if (!count) return -1;
  const delta = direction === "up" || direction === "left" ? -1 : 1;
  return Math.max(0, Math.min(count - 1, index + delta));
}

export class ControllerHistory {
  constructor(host, { onRead, onBack, onClose }) {
    this.host = host;
    this.onRead = onRead;
    this.onBack = onBack;
    this.onClose = onClose;
    this.root = null;
    this.entries = [];
    this.index = 0;
    this.node = null;
  }

  show(entries, center) {
    this.remove();
    this.entries = historyEntries(entries);
    const root = document.createElement("section");
    root.className = "cm-history";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Recent text");
    root.style.left = `${center.x}px`;
    root.style.top = `${center.y}px`;
    const heading = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = "Recent text";
    heading.append(title);
    const close = document.createElement("button");
    close.textContent = "Close";
    close.addEventListener("click", this.onClose);
    heading.append(close);
    const content = document.createElement("div");
    content.className = "cm-history-content";
    const hints = document.createElement("footer");
    hints.textContent = "D-pad / stick: choose · A: read words · B: back";
    root.append(heading, content, hints);
    this.root = root;
    this.content = content;
    this.hints = hints;
    this.host.append(root);
    this.showList();
  }

  showList() {
    if (!this.root) return;
    this.node = null;
    this.content.replaceChildren();
    this.hints.textContent = "D-pad / stick: choose · A: read words · B: back";
    if (!this.entries.length) {
      const empty = document.createElement("p");
      empty.textContent = "No recent text yet. Scan some Japanese text first.";
      this.content.append(empty);
    }
    this.rows = this.entries.map((entry, index) => {
      const row = document.createElement("button");
      row.className = "cm-history-entry";
      const detail = document.createElement("small");
      const name =
        entry.source?.appName ??
        entry.source?.name;
      const time = Number.isFinite(entry.timestamp)
        ? new Date(entry.timestamp).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      detail.textContent = [name, time].filter(Boolean).join(" · ");
      const text = document.createElement("span");
      text.textContent = entry.text;
      row.append(detail, text);
      row.addEventListener("click", () => {
        this.index = index;
        this.onRead();
      });
      this.content.append(row);
      return row;
    });
    this.select(this.index);
  }

  select(index) {
    this.index = Math.max(0, Math.min(this.entries.length - 1, index));
    this.rows?.forEach((row, at) =>
      row.setAttribute("aria-current", String(at === this.index)),
    );
    this.rows?.[this.index]?.scrollIntoView({ block: "nearest" });
  }

  move(direction) {
    this.select(historyIndex(this.index, direction, this.entries.length));
  }

  read() {
    const entry = this.entries[this.index];
    if (!entry) return false;
    this.content.replaceChildren();
    const back = document.createElement("button");
    back.textContent = "Back to recent text";
    back.addEventListener("click", this.onBack);
    const text = document.createElement("div");
    text.className = "cm-history-text";
    this.node = document.createTextNode(entry.text);
    text.append(this.node);
    this.content.append(back, text);
    this.hints.textContent =
      "D-pad / stick: word · LB / RB: definition · RS: scroll · B: recent text";
    return true;
  }

  units() {
    return this.node
      ? [
          {
            element: this.node.parentElement,
            node: this.node,
            text: this.node.textContent,
            vertical: false,
            history: true,
          },
        ]
      : [];
  }

  ensureVisible(range) {
    const rect = range.getBoundingClientRect();
    const viewport = this.content.getBoundingClientRect();
    if (rect.top < viewport.top)
      this.content.scrollTop -= viewport.top - rect.top + 8;
    else if (rect.bottom > viewport.bottom)
      this.content.scrollTop += rect.bottom - viewport.bottom + 8;
  }

  bounds() {
    return this.root?.getBoundingClientRect() ?? null;
  }
  remove() {
    this.root?.remove();
    this.root = null;
    this.node = null;
  }
}

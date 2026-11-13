/**
 * Where a character of a text area is drawn, in viewport pixels: a text area cannot say where its
 * caret is, so a hidden copy of it, styled the same and holding the text up to that point, does.
 * Used only while a menu needs placing at the caret (the @-mention menu), never per keystroke
 * otherwise.
 */

/** Everything that decides where text lays out in the box. */
const COPIED = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontFamily",
  "fontFeatureSettings",
  "fontKerning",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textTransform",
  "textIndent",
  "tabSize",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
  "lineBreak",
] as const;

let mirror: HTMLDivElement | null = null;

export interface CaretPoint {
  left: number;
  top: number;
  /** The height of a line there: the caret runs from `top` to `top + height`. */
  height: number;
}

export function caretPoint(box: HTMLTextAreaElement, index: number): CaretPoint {
  if (!mirror) {
    mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    Object.assign(mirror.style, {
      position: "absolute",
      top: "0",
      left: "-9999px",
      visibility: "hidden",
      overflow: "hidden",
      pointerEvents: "none",
    });
    document.body.appendChild(mirror);
  }
  const style = getComputedStyle(box);
  for (const prop of COPIED) mirror.style[prop] = style[prop];
  mirror.style.height = "auto";
  mirror.textContent = box.value.slice(0, index);
  const marker = document.createElement("span");
  // Something to measure even at the end of the text (or of a line).
  marker.textContent = box.value.slice(index, index + 1) || "​";
  mirror.appendChild(marker);
  const rect = box.getBoundingClientRect();
  const line = parseFloat(style.lineHeight) || marker.offsetHeight;
  return {
    left: rect.left + marker.offsetLeft - box.scrollLeft,
    top: rect.top + marker.offsetTop - box.scrollTop,
    height: line,
  };
}

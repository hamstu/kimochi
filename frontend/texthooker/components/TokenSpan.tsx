import { invoke } from "@tauri-apps/api/core";
import { buildAnkiConfigForPopover } from "@texthooker/lib/ankiConfig";
import type { Token } from "@texthooker/lib/types";
import { getSettings } from "@texthooker/lib/settings";

interface Props {
  token: Token;
  yomitanBaseUrl: string;
  showFurigana: boolean;
  sentence?: string;
  /** When true, suppress click-to-show-definition and render as plain
      selectable text. Scan mode (Shift+hover) still works because it operates
      on text nodes regardless of the wrapper. */
  disableClickToDefine?: boolean;
}

function renderDisplay(token: Token, showFurigana: boolean) {
  if (showFurigana && token.reading && token.reading !== token.text) {
    const kanjiMatch = token.text.match(/^[一-鿿㐀-䶿]+/);
    if (kanjiMatch) {
      const kanji = kanjiMatch[0];
      const tail = token.text.slice(kanji.length);
      if (tail) {
        return (
          <ruby>
            {kanji}
            <rt>{token.reading}</rt>
            {tail}
            <rt></rt>
          </ruby>
        );
      }
      return (
        <ruby>
          {kanji}
          <rt>{token.reading}</rt>
        </ruby>
      );
    }
    return (
      <ruby>
        {token.text}
        <rt>{token.reading}</rt>
      </ruby>
    );
  }
  return token.text;
}

export function TokenSpan({
  token,
  yomitanBaseUrl,
  showFurigana,
  sentence,
  disableClickToDefine,
}: Props) {
  const isClickable =
    token.clickable && !!token.text.trim() && !disableClickToDefine;
  const display = renderDisplay(token, showFurigana);

  if (!isClickable) {
    // Plain span — preserves text-selection behavior. Dim non-dictionary
    // tokens; when click-to-define is off, keep dictionary tokens at the
    // regular color so the transcript reads as ordinary text.
    return (
      <span className={token.clickable ? undefined : "log-token-dim"}>
        {display}
      </span>
    );
  }

  const handleClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const settings = getSettings();
    // The word's box on the desktop (screen − client is the viewport's origin), so the popup
    // sits above the word rather than wherever on it the click landed.
    const box = e.currentTarget.getBoundingClientRect();
    try {
      await invoke("show_popover", {
        term: token.text,
        cursorX: e.screenX,
        cursorY: e.screenY,
        anchor: {
          x: box.left + e.screenX - e.clientX,
          y: box.top + e.screenY - e.clientY,
          width: box.width,
          height: box.height,
        },
        width: settings.popoverWidth,
        height: settings.popoverHeight,
        baseUrl: yomitanBaseUrl,
        focus: true,
        sentence: sentence ?? null,
        includeMedia: settings.audioEnabled || settings.ankiEnabled,
        audioAutoplay: settings.audioEnabled && settings.audioAutoplay,
        audioVolume: settings.audioVolume,
        ankiConfig: buildAnkiConfigForPopover(settings),
      });
    } catch (err) {
      console.warn("show_popover failed", err);
    }
  };

  return (
    <button
      type="button"
      translate="no"
      onMouseDown={(e) => e.preventDefault()}
      onClick={handleClick}
      className="log-token"
    >
      {display}
    </button>
  );
}

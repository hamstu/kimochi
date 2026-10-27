import { useEffect, useRef } from "react";
import { Image as ImageIcon, Plus, Volume2 } from "lucide-react";
import { Tooltip } from "@kit";
import {
  lineProgress,
  toggleLineAudio,
  useLineAudio,
  useLinePlaying,
} from "@texthooker/lib/sentenceAudio";
import { scanOf, showShot, useShot } from "@texthooker/lib/screenshots";
import type { Line } from "@texthooker/lib/types";

/**
 * What a line has besides its text, at the row's end beside its actions: the voice of the line
 * (sentence audio) and the screenshot of its scan, each a small chip as tall as the text. The row
 * makes room only for the chips it has (log.css).
 */
export function LineMedia({ line }: { line: Line }) {
  return (
    <span className="line-media">
      <VoiceChip uid={line.uid} />
      <ShotChip line={line} />
    </span>
  );
}

/**
 * Sentence audio's chip (src-tauri/src/sentence_audio): a speaker and the clip's length. A click
 * plays it, filling the chip from left to right as it goes; another stops it. Nothing while the
 * line is still being listened to, when no voice was found, or when sentence audio is off.
 */
function VoiceChip({ uid }: { uid: string | undefined }) {
  const audio = useLineAudio(uid);
  const playing = useLinePlaying(uid);
  const chip = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = chip.current;
    if (!playing || !uid || !element) return;
    let frame = 0;
    const tick = () => {
      element.style.setProperty("--played", String(lineProgress(uid) ?? 0));
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(frame);
      element.style.removeProperty("--played");
    };
  }, [playing, uid]);

  if (!uid || audio?.state !== "voiced") return null;
  const seconds = ((audio.durationMs ?? 0) / 1000).toFixed(1);
  return (
    <Tooltip content={playing ? "Stop" : "Play the line's voice"} delayDuration={400}>
      <button
        ref={chip}
        type="button"
        className="line-chip line-chip-voice"
        aria-label={playing ? "Stop" : `Play the line's voice (${seconds} seconds)`}
        data-playing={playing || undefined}
        // Keep the row's selection / scan handling out of the chip.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          void toggleLineAudio(uid);
        }}
      >
        <Volume2 aria-hidden />
        <span className="line-chip-text">{seconds}s</span>
      </button>
    </Tooltip>
  );
}

/**
 * The screenshot's chip (src-tauri/src/screenshots.rs): an image mark and the picture, cropped to
 * fill the chip. Every line of a scan shows the same one; a click opens the viewer
 * (ScreenshotViewer). Nothing for lines that came without a picture (the clipboard, a WebSocket)
 * or whose screenshot is no longer kept.
 */
function ShotChip({ line }: { line: Line }) {
  const shot = useShot(scanOf(line));
  if (!shot) return null;
  return (
    <button
      type="button"
      className="line-chip line-chip-shot"
      aria-label="Show the screenshot"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        showShot(shot.scan);
      }}
    >
      <ImageIcon aria-hidden />
      <span className="line-chip-picture">
        <img src={shot.url} alt="" loading="lazy" draggable={false} />
        <Plus className="line-chip-zoom" aria-hidden />
      </span>
    </button>
  );
}

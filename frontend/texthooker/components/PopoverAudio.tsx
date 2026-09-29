import { useEffect, useMemo, useRef } from "react";
import { Volume2 } from "lucide-react";
import { getOrCacheAudio, playAudio } from "@texthooker/lib/audio";
import type { AnkiMediaItem } from "@texthooker/lib/types";

interface Props {
  /** This entry's own audio file (resolved via audioItemForEntry), or null. */
  item: AnkiMediaItem | null;
  autoplay: boolean;
  volume: number;
}

/** Speaker icon for one popover entry. Renders nothing when the entry has no
    audio, so the button only appears when it's useful. */
export function PopoverAudio({ item, autoplay, volume }: Props) {
  const url = useMemo(() => (item ? getOrCacheAudio(item) : null), [item]);

  // Autoplay once per (term, url) pair — guard so a re-render doesn't re-fire.
  const lastPlayedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!url || !autoplay) return;
    if (lastPlayedRef.current === url) return;
    lastPlayedRef.current = url;
    void playAudio(url, volume);
  }, [url, autoplay, volume]);

  if (!url) return null;

  return (
    <button
      type="button"
      onClick={() => playAudio(url, volume)}
      title="Play audio"
      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-(--color-border) bg-(--color-bg-elev) text-(--color-text-dim) hover:text-(--color-text) hover:bg-(--color-bg-elev-2) cursor-pointer"
    >
      <Volume2 className="h-3.5 w-3.5" />
    </button>
  );
}

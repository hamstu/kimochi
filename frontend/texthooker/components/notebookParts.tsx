import type { ReactNode } from "react";
import { cn } from "@kit";
import type { NotebookEntry } from "@texthooker/lib/types";
import { KIND_META, useImageUrl } from "./notebookEntry";

/** First image, else a monogram (characters) or the kind icon (places, things). */
export function EntryAvatar({
  entry,
  large,
}: {
  entry: NotebookEntry;
  large?: boolean;
}): ReactNode {
  const url = useImageUrl(entry.images[0]);
  const monogram =
    entry.kind === "person"
      ? Array.from(entry.family.trim() || entry.given.trim())[0]
      : undefined;
  return (
    <span
      aria-hidden
      data-kind={url ? undefined : entry.kind}
      className={cn("nb-avatar", large && "nb-avatar-lg")}
      lang="ja"
    >
      {url ? (
        <img src={url} alt="" draggable={false} />
      ) : entry.kind === "person" && monogram ? (
        monogram
      ) : (
        KIND_META[entry.kind].icon
      )}
    </span>
  );
}

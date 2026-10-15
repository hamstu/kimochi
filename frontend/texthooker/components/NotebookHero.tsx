/**
 * The header of a notebook entry wherever it is shown in detail (the reader popover and the
 * Notebook editor): a portrait box at the left holding the entry's picture (or, without one, a
 * monogram or the kind's icon), the name beside it, over a dotted band tinted by the kind.
 * The picture is never stretched across the header: entry pictures are often small, and a wide
 * crop cut the heads off portraits. Presentational only: it imports no notebook store, so the
 * popover window can use it.
 */
import type { ReactNode } from "react";
import { Box, MapPin, UserRound } from "lucide-react";
import "../notebook-hero.css";

export type HeroKind = "person" | "place" | "thing";

const KIND_ICON: Record<HeroKind, ReactNode> = {
  person: <UserRound />,
  place: <MapPin />,
  thing: <Box />,
};

export function NotebookHero({
  imageUrl,
  kind,
  name,
  reading,
  caption,
  actions,
  size = "popover",
}: {
  imageUrl: string | null;
  kind: HeroKind;
  name: string;
  reading?: string;
  /** A short line under the name (e.g. the kind, in the editor). */
  caption?: ReactNode;
  /** Top-right controls, drawn over the hero. */
  actions?: ReactNode;
  size?: "popover" | "editor";
}) {
  const monogram =
    kind === "person" && name.trim() ? Array.from(name.trim())[0] : null;
  return (
    <header
      className="nb-hero"
      data-size={size}
      data-image={imageUrl ? "" : undefined}
      data-actions={actions ? "" : undefined}
      data-kind={kind}
    >
      <span className="nb-hero-portrait">
        {imageUrl ? (
          <img className="nb-hero-image" src={imageUrl} alt="" draggable={false} />
        ) : (
          <span className="nb-hero-mark" aria-hidden lang="ja">
            {monogram ?? KIND_ICON[kind]}
          </span>
        )}
      </span>
      {actions ? <div className="nb-hero-actions">{actions}</div> : null}
      <div className="nb-hero-text">
        <h2 className="nb-hero-name" lang="ja" translate="no">
          {name}
        </h2>
        {reading || caption ? (
          <p className="nb-hero-sub">
            {reading ? (
              <span lang="ja" translate="no">
                {reading}
              </span>
            ) : null}
            {reading && caption ? <span aria-hidden> · </span> : null}
            {caption}
          </p>
        ) : null}
      </div>
    </header>
  );
}

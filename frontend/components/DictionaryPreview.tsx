/**
 * A picture of a dictionary engine's pop-up, for choosing between engines (Settings → Dictionary,
 * onboarding's dictionary step): a thumbnail that opens full size in a dialog.
 *
 * The pictures are the files in frontend/assets/dictionary-previews/ (README there), found at
 * build time, so a missing one is simply not shown. Each engine has a light and a dark picture,
 * `<engine>-light` and `<engine>-dark`; the one matching the window's theme shows (CSS on the
 * `.dark` class the appearance controller sets), and an engine with only one uses it for both.
 * A PNG or JPEG of a name wins over the captured WebP, so a screenshot dropped in by hand replaces
 * it without deleting anything.
 */
import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogTrigger } from "@kit";
import {
  DICTIONARY_ENGINES,
  type DictionaryEngine,
} from "../bridge/dictionaryEngine";
import "./dictionary-preview.css";

const FILES = import.meta.glob<string>(
  "../assets/dictionary-previews/*.{png,jpg,jpeg,webp}",
  {
    eager: true,
    query: "?url",
    import: "default",
  },
);

/** Formats in order of preference: a hand-made screenshot over the capture. */
const FORMATS = ["png", "jpg", "jpeg", "webp"];

function picture(name: string): string | null {
  for (const format of FORMATS) {
    const url = FILES[`../assets/dictionary-previews/${name}.${format}`];
    if (url) return url;
  }
  return null;
}

type Theme = "light" | "dark";

/** The engine's picture for each theme, falling back to the other theme's; null when it has none. */
function previewPictures(
  engine: DictionaryEngine,
): Record<Theme, string> | null {
  const light = picture(`${engine}-light`);
  const dark = picture(`${engine}-dark`);
  if (!light && !dark) return null;
  return { light: light ?? dark!, dark: dark ?? light! };
}

function Picture({
  pictures,
  alt,
  className,
}: {
  pictures: Record<Theme, string>;
  alt: string;
  className: string;
}): ReactNode {
  // Both are in the page; CSS shows the one for the theme, and the hidden one is never fetched.
  return (
    <>
      <img
        className={`${className} dictionary-preview-light`}
        src={pictures.light}
        alt={alt}
        loading="lazy"
      />
      <img
        className={`${className} dictionary-preview-dark`}
        src={pictures.dark}
        alt={alt}
        loading="lazy"
      />
    </>
  );
}

export function DictionaryPreview({
  engine,
}: {
  engine: DictionaryEngine;
}): ReactNode {
  const pictures = previewPictures(engine);
  if (!pictures) return null;
  const name = DICTIONARY_ENGINES[engine].name;
  const alt = `${name}'s pop-up, looking up 食べられなかった in a line of game dialogue`;
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          className="dictionary-preview"
          aria-label={`Show ${name}'s pop-up larger`}
        >
          <Picture
            pictures={pictures}
            alt={alt}
            className="dictionary-preview-image"
          />
        </button>
      </DialogTrigger>
      <DialogContent
        size="lg"
        title={`${name} pop-up`}
        description="Looking up 食べられなかった (couldn't eat) in a game's dialogue. Entries from JMdict."
      >
        <Picture
          pictures={pictures}
          alt={alt}
          className="dictionary-preview-full"
        />
      </DialogContent>
    </Dialog>
  );
}

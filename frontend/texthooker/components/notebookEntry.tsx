/* eslint react-hooks/set-state-in-effect: "off" -- Object URLs are created and revoked as the entry's first image changes. */
import { useEffect, useState, type ReactNode } from "react";
import { Box, MapPin, UserRound } from "lucide-react";
import { readImageAsObjectURL } from "@texthooker/lib/notebook";
import type {
  NotebookEntry,
  NotebookImage,
  NotebookKind,
} from "@texthooker/lib/types";

export const KIND_META: Record<
  NotebookKind,
  { one: string; many: string; icon: ReactNode }
> = {
  person: { one: "Character", many: "Characters", icon: <UserRound /> },
  place: { one: "Place", many: "Places", icon: <MapPin /> },
  thing: { one: "Thing", many: "Things", icon: <Box /> },
};

export const KIND_ORDER: readonly NotebookKind[] = ["person", "place", "thing"];

/** The entry's written name, or "" when it has none yet. */
export function entryName(entry: NotebookEntry): string {
  if (entry.kind === "person") {
    return [entry.family.trim(), entry.given.trim()].filter(Boolean).join(" ");
  }
  return entry.name.trim();
}

export function entryReading(entry: NotebookEntry): string {
  const name = entryName(entry);
  const reading =
    entry.kind === "person"
      ? [entry.familyReading?.trim(), entry.givenReading?.trim()]
          .filter(Boolean)
          .join(" ")
      : (entry.reading?.trim() ?? "");
  return reading && reading !== name ? reading : "";
}

/** Everything a search should look at, lower-cased once per entry. */
export function entryHaystack(entry: NotebookEntry): string {
  const parts: (string | undefined)[] = [
    entryName(entry),
    entryReading(entry),
    entry.description,
    ...entry.aliases,
    ...(entry.notes ?? []).map((note) => note.text),
  ];
  if (entry.kind === "person") parts.push(entry.family + entry.given);
  return parts.filter(Boolean).join("\n").toLowerCase();
}

/** Object URL for a notebook image, revoked when the image changes or unmounts. */
export function useImageUrl(image: NotebookImage | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!image) {
      setUrl(null);
      return;
    }
    let revoked = false;
    let current: string | null = null;
    void readImageAsObjectURL(image)
      .then((next) => {
        if (revoked) {
          URL.revokeObjectURL(next);
          return;
        }
        current = next;
        setUrl(next);
      })
      .catch(() => setUrl(null));
    return () => {
      revoked = true;
      if (current) URL.revokeObjectURL(current);
    };
  }, [image]);
  return url;
}


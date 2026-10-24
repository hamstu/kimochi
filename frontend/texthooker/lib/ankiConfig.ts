/* ankiConfig.ts — derive the AnkiConfig blob handed to the popover via the
   show_popover invoke. Returns null when mining isn't ready (disabled, no
   deck/model, or no cached field list yet). The popover hides the + button
   when null. */

import { DEFAULT_ANKI_CONNECT_URL } from "@ui/anki-connect";
import type { Settings } from "./types";
import type { AnkiConfig } from "@texthooker/components/PopoverAddToAnki";

export function buildAnkiConfigForPopover(s: Settings): AnkiConfig | null {
  if (!s.ankiEnabled) return null;
  if (!s.ankiDeckName || !s.ankiModelName) return null;
  if (s.ankiModelFields.length === 0) return null;
  return {
    // Empty is AnkiConnect's default address, as Settings → Anki shows it.
    ankiConnectUrl: s.ankiConnectUrl.trim() || DEFAULT_ANKI_CONNECT_URL,
    deck: s.ankiDeckName,
    model: s.ankiModelName,
    modelFields: s.ankiModelFields,
    mappings: s.ankiFieldMappings,
    tags: s.ankiTags,
  };
}

/** Why the pop-up shows no Add to Anki although mining is on (what `buildAnkiConfigForPopover`
    waits for), for Settings → Anki; null when nothing is missing. `fieldsListed`: the note type's
    fields were just read from Anki and are being saved. */
export function ankiMiningGap(
  s: Pick<Settings, "ankiDeckName" | "ankiModelName" | "ankiModelFields">,
  fieldsListed = false,
): string | null {
  if (!s.ankiDeckName && !s.ankiModelName)
    return "Choose a deck and a note type (or use Detect) before the pop-up shows Add to Anki.";
  if (!s.ankiDeckName) return "Choose a deck before the pop-up shows Add to Anki.";
  if (!s.ankiModelName) return "Choose a note type before the pop-up shows Add to Anki.";
  if (s.ankiModelFields.length === 0 && !fieldsListed)
    return "Open Anki so Kimochi can read this note type's fields; until then the pop-up shows no Add to Anki.";
  return null;
}

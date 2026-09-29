/* ankiConfig.ts — derive the AnkiConfig blob handed to the popover via the
   show_popover invoke. Returns null when mining isn't ready (disabled, no
   deck/model, or no cached field list yet). The popover hides the + button
   when null. */

import type { Settings } from "./types";
import type { AnkiConfig } from "@texthooker/components/PopoverAddToAnki";

export function buildAnkiConfigForPopover(s: Settings): AnkiConfig | null {
  if (!s.ankiEnabled) return null;
  if (!s.ankiDeckName || !s.ankiModelName) return null;
  if (s.ankiModelFields.length === 0) return null;
  return {
    ankiConnectUrl: s.ankiConnectUrl,
    deck: s.ankiDeckName,
    model: s.ankiModelName,
    modelFields: s.ankiModelFields,
    mappings: s.ankiFieldMappings,
    tags: s.ankiTags,
  };
}

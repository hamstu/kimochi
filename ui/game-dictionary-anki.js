/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Add to Anki for the full-screen dictionary (ui/game-dictionary.js), with Kimochi's own Anki
 * settings (Settings → Anki, the `superTexthooker` reader settings; `popupAnkiConfig` in
 * api-lookup.js decides when they are complete).
 *
 * The same AnkiConnect commands and the same field rules as the Yomitan API pop-up's button
 * (`sendCardForTerm` in frontend/texthooker/lib/ankiconnect.ts): the overlay is plain ES modules
 * without a bundler, so it cannot import that TypeScript module and carries this copy of its
 * rules. Change both together.
 */

/** The value one Anki field takes: a Yomitan marker, the sentence, a fixed text, or nothing. */
export function fieldValue(mapping, fields, sentence) {
  switch (mapping?.mappingType) {
    case "marker": {
      const value = mapping.marker ? fields?.[mapping.marker] : "";
      return typeof value === "string" ? value : "";
    }
    case "sentence":
      return sentence ?? "";
    case "literal":
      return mapping.literal ?? "";
    default:
      return "";
  }
}

/** The note's fields for an entry: every field of the note type, empty where nothing maps to it. */
export function noteFields(config, fields, sentence) {
  const byField = new Map(config.mappings.map((mapping) => [mapping.ankiField, mapping]));
  return Object.fromEntries(
    config.modelFields.map((name) => [name, fieldValue(byField.get(name), fields, sentence)]),
  );
}

/** The field Anki checks for duplicates (the note type's first) and its value for this entry. */
export function expressionField(config, fields, sentence) {
  const name = config.modelFields[0] ?? "Expression";
  const mapping = config.mappings.find((m) => m.ankiField === name);
  return { name, value: mapping ? fieldValue(mapping, fields, sentence) : "" };
}

const quote = (text) => String(text).replace(/"/g, '\\"');

/**
 * Add to Anki over `invoke` (Tauri's), for a complete `config` (`popupAnkiConfig`).
 *
 * @param {(command: string, args: object) => Promise<any>} invoke
 * @param {{ankiConnectUrl: string, deck: string, model: string, modelFields: string[], mappings: object[], tags: string[]}} config
 */
export function createAnki(invoke, config) {
  const url = config.ankiConnectUrl;
  return {
    /** The note already in the deck for this entry, or null; throws when Anki cannot be asked. */
    async exists(fields, sentence) {
      const { name, value } = expressionField(config, fields, sentence);
      if (!value.trim()) return null;
      const ids = await invoke("anki_find_notes", {
        url,
        query: `"deck:${quote(config.deck)}" "${quote(name)}:${quote(value)}"`,
      });
      return ids?.length ? ids[0] : null;
    },
    /** Store the entry's media, then add its note; a duplicate answers with the note already there. */
    async add({ fields, audioMedia, dictionaryMedia }, sentence) {
      for (const item of [...(audioMedia ?? []), ...(dictionaryMedia ?? [])]) {
        await invoke("anki_store_media_file", {
          url,
          filename: item.ankiFilename,
          dataBase64: item.contentBase64 ?? item.content,
        });
      }
      try {
        const id = await invoke("anki_add_note", {
          url,
          deck: config.deck,
          model: config.model,
          fields: noteFields(config, fields, sentence),
          tags: config.tags,
          allowDuplicate: false,
        });
        return { noteId: id, duplicate: false };
      } catch (error) {
        if (!/duplicate/i.test(String(error))) throw error;
        const { name, value } = expressionField(config, fields, sentence);
        const ids = await invoke("anki_find_notes", { url, query: `"${quote(name)}:${quote(value)}"` }).catch(() => []);
        if (ids?.length) return { noteId: ids[0], duplicate: true };
        throw error;
      }
    },
    /** Show the note in Anki's browser. */
    async open(noteId) {
      await invoke("anki_gui_browse", { url, query: `nid:${noteId}` });
    },
  };
}

export default { createAnki, noteFields, expressionField, fieldValue };

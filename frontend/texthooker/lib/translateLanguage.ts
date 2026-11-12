/**
 * What translation can do with the language being read: whether your DeepL key can translate from
 * it (the same list as `deepl_source` in src-tauri/src/language.rs; `translate-language.test.mjs`
 * keeps the two in step), and the native refusal turned into a sentence for the Log.
 */
import { languageOf } from "../../../ui/languages";

/** The app's language codes DeepL translates from. */
export const DEEPL_SOURCES: ReadonlySet<string> = new Set([
  "ja", "ko", "zh-Hans", "zh-Hant", "th", "vi", "en", "es", "fr", "de", "it", "pt", "ru",
  "id", "tr", "pl", "nl", "sv", "no", "da", "fi", "el", "uk", "cs", "hu", "ro", "bg", "et", "lv",
]);

/** Whether your DeepL key can translate from the language. */
export const deeplTranslates = (code: unknown): boolean =>
  DEEPL_SOURCES.has(languageOf(code).code);

const DEEPL_REFUSAL = "DeepL cannot translate from this language";

/** A translation error as the Log shows it: DeepL's refusal of the language names the language
    and the way out; anything else is passed through. */
export function translationErrorMessage(raw: string, code: unknown): string {
  if (!raw.startsWith(DEEPL_REFUSAL)) return raw;
  return `DeepL can't translate from ${languageOf(code).name}. Choose Kimochi cloud in Settings → Translation & AI.`;
}

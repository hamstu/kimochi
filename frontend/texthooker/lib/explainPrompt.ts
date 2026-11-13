/**
 * The Explain prompt: the default template, which fits itself to the language being learned, and
 * how a stored prompt becomes the text a provider gets.
 *
 * A template has three placeholders: `{{language}}` (the language's English name), `{{context}}`
 * (the previous lines) and `{{sentence}}` (the line explained). The default names the language
 * through `{{language}}` and keeps its Japanese-only guidance (quotation marks, particles) for
 * Japanese, so for Japanese it renders exactly as the prompt did before there was a language.
 *
 * A stored prompt that is one of the defaults (today's template for any language, or the prompt
 * Kimochi stored before languages) counts as "the default" and follows the language; anything
 * else is the user's own and is sent as written.
 */
import { DEFAULT_LANGUAGE, LANGUAGES, isJapanese, languageOf } from "../../../ui/languages";

/** The default prompt as Kimochi stored it before there was a language setting. */
export const LEGACY_EXPLAIN_PROMPT = `You are an expert Japanese tutor helping a learner read native Japanese media. The sentence below comes from a game, comic, anime, or other Japanese media — most likely an anime or a visual novel.

Explain the TARGET SENTENCE. The PREVIOUS LINES are earlier text from the same scene, given only so you can read the target in context — do not explain them.

Guidelines:
- Focus on grammar over vocabulary. The reader can look up individual words themselves; what they need from you is how the sentence fits together: grammar points, conjugations, particles, sentence-ending nuances, omitted subjects/objects, and register (casual, polite, rough, archaic, dialect).
- Call out nuance: what the phrasing implies about the speaker's attitude, emotion, or relationship to the listener, and anything a learner would likely misread.
- Explain any cultural references or culturally loaded expressions briefly when they matter to understanding.
- Note on quotation marks: in visual novels, text wrapped in 「…」 or 『…』 is usually spoken dialogue, while lines without Japanese quotation marks are often the protagonist's inner thoughts or narration. This convention is specific to visual novels and may not always apply.
- Structure the answer in Markdown. Start with a one-line natural English translation, then the grammar breakdown as a short list. Bold the Japanese fragments you discuss. Keep it tight — no filler, no restating these instructions.

PREVIOUS LINES (oldest first):
{{context}}

TARGET SENTENCE:
{{sentence}}`;

const GRAMMAR_JA =
  "grammar points, conjugations, particles, sentence-ending nuances, omitted subjects/objects, and register (casual, polite, rough, archaic, dialect)";
const GRAMMAR =
  "grammar points, conjugations and inflections, word order, omitted words, and register (casual, polite, rough, archaic, dialect)";
const QUOTES_JA =
  "- Note on quotation marks: in visual novels, text wrapped in 「…」 or 『…』 is usually spoken dialogue, while lines without Japanese quotation marks are often the protagonist's inner thoughts or narration. This convention is specific to visual novels and may not always apply.\n";

/** The default template for a language (a code; anything unknown reads as Japanese). */
export function defaultExplainPrompt(code: unknown = DEFAULT_LANGUAGE): string {
  const ja = isJapanese(code);
  return `You are an expert {{language}} tutor helping a learner read native {{language}} media. The sentence below comes from a game, comic, anime, or other {{language}} media — most likely an anime or a visual novel.

Explain the TARGET SENTENCE. The PREVIOUS LINES are earlier text from the same scene, given only so you can read the target in context — do not explain them.

Guidelines:
- Focus on grammar over vocabulary. The reader can look up individual words themselves; what they need from you is how the sentence fits together: ${ja ? GRAMMAR_JA : GRAMMAR}.
- Call out nuance: what the phrasing implies about the speaker's attitude, emotion, or relationship to the listener, and anything a learner would likely misread.
- Explain any cultural references or culturally loaded expressions briefly when they matter to understanding.
${ja ? QUOTES_JA : ""}- Structure the answer in Markdown. Start with a one-line natural English translation, then the grammar breakdown as a short list. Bold the {{language}} fragments you discuss. Keep it tight — no filler, no restating these instructions.

PREVIOUS LINES (oldest first):
{{context}}

TARGET SENTENCE:
{{sentence}}`;
}

const DEFAULTS = new Set<string>([
  LEGACY_EXPLAIN_PROMPT,
  ...LANGUAGES.map((language) => defaultExplainPrompt(language.code)),
]);

/** Whether a stored prompt is a default (or empty), so it follows the language. */
export function isDefaultExplainPrompt(prompt: unknown): boolean {
  return typeof prompt !== "string" || !prompt.trim() || DEFAULTS.has(prompt);
}

/** The template a stored prompt stands for with this language. */
export function explainTemplate(stored: unknown, code: unknown): string {
  return isDefaultExplainPrompt(stored) ? defaultExplainPrompt(code) : (stored as string);
}

/** A template with its placeholders filled in. */
export function renderExplainPrompt(
  template: string,
  values: { language: string; context: string; sentence: string },
): string {
  return template
    .split("{{language}}")
    .join(values.language)
    .split("{{context}}")
    .join(values.context)
    .split("{{sentence}}")
    .join(values.sentence);
}

/** The prompt sent for a stored prompt, a language code, the previous lines and the line. */
export function explainPromptFor(
  stored: unknown,
  code: unknown,
  context: string,
  sentence: string,
): string {
  return renderExplainPrompt(explainTemplate(stored, code), {
    language: languageOf(code).name,
    context,
    sentence,
  });
}

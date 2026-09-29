/**
 * Yomitan emits the conjugation chain as a string like "-て « -いる",
 * read right-to-left from the surface form back toward the dictionary form.
 * Each step is a Yomitan deinflection rule name; for the common ones we
 * provide a short tooltip explanation.
 *
 * When more than one deinflection path matches (e.g. 連れてこられた is both
 * passive and potential-or-passive), Yomitan wraps the alternatives in HTML:
 * "<ul><li>passive « -た</li><li>potential or passive « -た</li></ul>".
 * We parse that into multiple chains rather than rendering the markup as text.
 */

export interface InflectionStep {
  rule: string;
  description?: string;
}

const RULE_DESCRIPTIONS: Record<string, string> = {
  // Inflection forms
  "-て":
    "Te-form: connective form, used for sequence, request, or before auxiliaries like ~いる, ~ある.",
  "-た": "Past tense plain (informal).",
  "-ない": "Plain negative.",
  "-なかった": "Plain past negative.",
  "-ます": "Polite non-past.",
  "-ました": "Polite past.",
  "-ません": "Polite negative.",
  "-ませんでした": "Polite past negative.",
  "-いる": "Progressive / continuous / resultant state (~ている).",
  "-ある": "State of being / existence after a transitive verb (~てある).",
  "-おく": "Doing in advance (~ておく).",
  "-しまう": "Completion or regret (~てしまう).",
  "-みる": "Trying to do (~てみる).",
  "-いく": "Going to / continuing outward (~ていく).",
  "-くる": "Coming to / continuing inward (~てくる).",
  // Causative / passive / potential
  "-れる": "Passive / honorific (godan / suru).",
  "-られる": "Passive / potential / honorific (ichidan).",
  "-せる": "Causative (godan).",
  "-させる": "Causative (ichidan).",
  // Conditional / volitional / imperative
  "-ば": "Conditional (~ば).",
  "-たら": "Conditional (~たら).",
  "-なら": "Conditional (~なら).",
  "-う": "Volitional (godan).",
  "-よう": "Volitional (ichidan).",
  "-ろ": "Imperative (godan / sentence-final).",
  "-て (imperative)": "Imperative request.",
  // i-adjectives
  "-かった": "Plain past form (i-adjective).",
  "-くない": "Plain negative (i-adjective).",
  "-く": "Adverbial form (i-adjective).",
  // -masu derivatives
  "-ましょう": "Polite volitional.",
  // Honorific
  "-ください": "Polite request (~てください).",
  // -ず / -ぬ
  "-ず": "Classical negative.",
  "-ぬ": "Classical negative.",
  // English rule names (used by newer Yomitan deinflection descriptions,
  // especially in multi-path results).
  passive: "Passive voice (~れる / ~られる).",
  potential: "Potential form (~える / ~られる).",
  "potential or passive":
    "~られる: could be potential or passive (ambiguous for ichidan / kuru verbs).",
  causative: "Causative (~せる / ~させる).",
  negative: "Plain negative (~ない).",
  polite: "Polite form (~ます).",
  past: "Past tense (~た).",
  volitional: "Volitional (~う / ~よう).",
  imperative: "Imperative.",
  conditional: "Conditional.",
  "progressive or perfect": "~ている: progressive or resultant state.",
  adverbial: "Adverbial form (~く).",
};

/**
 * Parse the conjugation field into one or more deinflection chains.
 * Plain input ("-て « -いる") yields a single chain; the HTML <ul> form yields
 * one chain per <li> (each an alternative reading of the same surface form).
 */
export function parseInflectionChains(
  raw: string | undefined,
): InflectionStep[][] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];

  let chainStrings: string[];
  if (/<li[\s>]/i.test(trimmed)) {
    chainStrings = [...trimmed.matchAll(/<li[^>]*>(.*?)<\/li>/gis)].map(
      (m) => m[1],
    );
  } else {
    chainStrings = [trimmed];
  }

  return chainStrings
    .map((chain) =>
      chain
        // Defensively drop any other stray markup so it can never leak as text.
        .replace(/<[^>]*>/g, "")
        // Yomitan separator is « (U+00AB). Order: surface → ... → root.
        .split(/\s*«\s*/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((rule) => ({
          rule,
          description: RULE_DESCRIPTIONS[rule],
        })),
    )
    .filter((c) => c.length > 0);
}

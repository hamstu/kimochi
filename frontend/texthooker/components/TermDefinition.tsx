import { CircleAlert, SearchX } from "lucide-react";
import { Badge, EmptyState, Spinner, Tooltip } from "@kit";
import { displayHtml } from "../lib/html";
import { parseInflectionChains } from "@texthooker/lib/inflection";
import type { YomitanAnkiFields } from "@texthooker/lib/types";
import { useLanguage } from "../../bridge/useLanguage";
import { useTextLang } from "../../bridge/useTextLang";

interface Props {
  term: string;
  state: "loading" | "loaded" | "error" | "empty";
  fields?: YomitanAnkiFields | null;
  errorMessage?: string;
  /** Per-entry action buttons (audio, add-to-Anki), shown in the headword row. */
  actions?: React.ReactNode;
  /**
   * Called when a Yomitan cross-reference link (e.g. a redirect entry's
   * `⟶ 取り憑く`, or a "see also" headword) inside the glossary is clicked.
   * The argument is the linked term's text. When provided, those links render
   * as clickable and the click is intercepted here.
   */
  onCrossRef?: (term: string) => void;
}

/**
 * Yomitan renders cross-reference links in glossary HTML as
 * `<a href="#" lang="ja"><span>WORD</span></a>`. Walk up from a click target to
 * find such an anchor and return its text, or null if the click wasn't on one.
 * `lang` is the language being read (`useTextLang`): see `isReference`.
 */
function crossRefTargetFromEvent(
  e: React.MouseEvent<HTMLElement>,
  lang: string,
): string | null {
  let node: HTMLElement | null = e.target as HTMLElement;
  const container = e.currentTarget;
  while (node && node !== container) {
    if (node.tagName === "A") {
      const a = node as HTMLAnchorElement;
      // Yomitan's signature for an internal reference: a fragment href plus a
      // ja-tagged anchor. (Real external links would have a real href.)
      const href = a.getAttribute("href");
      if (isReference(a.lang, lang) && (href === "#" || href === null || href === "")) {
        const text = (a.textContent ?? "").trim();
        return text || null;
      }
      return null;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Whether an internal link's `lang` marks it as a headword in the language being read. Japanese:
 * a `ja`-tagged anchor, exactly as always. Another language: an anchor tagged with that language
 * by its first subtag (Yomitan tags both Chinese as `zh`, and Cantonese dictionaries may too), or
 * not tagged at all, as a dictionary for another language may leave it.
 */
function isReference(anchor: string, lang: string): boolean {
  if (lang === "ja") return anchor === "ja";
  if (!anchor) return true;
  const primary = (code: string) => code.toLowerCase().split("-")[0];
  return primary(anchor) === primary(lang) || (lang === "yue" && primary(anchor) === "zh");
}

function splitTags(value: string | undefined): string[] {
  if (!value || value === "Unknown") return [];
  return value
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function TermDefinition({
  term,
  state,
  fields,
  errorMessage,
  actions,
  onCrossRef,
}: Props) {
  // Inflection tooltips explain Japanese rules only.
  const [language] = useLanguage();
  // The headword and term are the learner's text; pitch accents are Japanese's own.
  const textLang = useTextLang();
  if (state === "loading") {
    return (
      <div className="popover-status" role="status">
        <Spinner label="Looking up" />
        <span>
          Looking up{" "}
          {term ? (
            <span className="popover-status-term" lang={textLang}>
              {term}
            </span>
          ) : null}
          …
        </span>
      </div>
    );
  }
  if (state === "error") {
    return (
      <EmptyState
        className="popover-empty"
        icon={<CircleAlert />}
        title="Lookup failed"
      >
        {errorMessage || "The dictionary did not answer."}
      </EmptyState>
    );
  }
  if (state === "empty" || !fields) {
    return (
      <EmptyState
        className="popover-empty"
        icon={<SearchX />}
        title="No entries"
      >
        {term ? (
          <>
            No dictionary has an entry for{" "}
            <span className="popover-status-term" lang={textLang}>
              {term}
            </span>
            .
          </>
        ) : (
          "No dictionary has an entry for this word."
        )}
      </EmptyState>
    );
  }

  const expression = fields.expression || term;
  const reading = fields.reading || "";
  const partsOfSpeech = splitTags(fields["part-of-speech"]);
  const tags = splitTags(fields.tags);
  const dictionary =
    fields.dictionary && fields.dictionary !== "Unknown"
      ? fields.dictionary
      : null;
  const inflectionChains = parseInflectionChains(fields.conjugation, language.code === "ja");

  return (
    <article className="popover-term">
      {/* Headword */}
      <header className="popover-headword">
        <div className="popover-headword-text jp-text" lang={textLang}>
          <span className="popover-expression k-selectable">{expression}</span>
          {reading && reading !== expression ? (
            <span className="popover-reading k-selectable">{reading}</span>
          ) : null}
        </div>
        {actions ? <div className="popover-actions">{actions}</div> : null}
      </header>

      {/* Inflection chains (multiple = alternative deinflection paths) */}
      {inflectionChains.length > 0 ? (
        <div className="popover-inflection">
          <span className="popover-meta-label">Inflected</span>
          {inflectionChains.map((chain, ci) => (
            <span key={ci} className="popover-inflection-chain">
              {ci > 0 ? <span className="popover-meta-label">or</span> : null}
              {chain.map((step, i) => (
                <span
                  key={`${step.rule}-${i}`}
                  className="popover-inflection-chain"
                >
                  <Tooltip
                    content={step.description ?? "Yomitan deinflection rule"}
                  >
                    <span tabIndex={0}>
                      <Badge>{step.rule}</Badge>
                    </span>
                  </Tooltip>
                  {i < chain.length - 1 ? (
                    <span className="popover-meta-sep" aria-hidden>
                      «
                    </span>
                  ) : null}
                </span>
              ))}
            </span>
          ))}
        </div>
      ) : null}

      {/* Pitch accents — trusted HTML from local Yomitan host */}
      {fields["pitch-accents"] ? (
        <div
          className="popover-pitch yomitan-html jp-text"
          lang="ja"
          dangerouslySetInnerHTML={{
            __html: displayHtml(fields["pitch-accents"]),
          }}
        />
      ) : null}

      {/* Badges */}
      {(dictionary || partsOfSpeech.length > 0 || tags.length > 0) && (
        <div className="popover-badges">
          {dictionary ? <Badge tone="accent">{dictionary}</Badge> : null}
          {partsOfSpeech.map((p) => (
            <Badge key={`pos-${p}`}>{p}</Badge>
          ))}
          {tags.map((t) => (
            <Badge key={`tag-${t}`}>{t}</Badge>
          ))}
        </div>
      )}

      {/* Glossary */}
      {fields.glossary ? (
        <div
          className={`popover-glossary yomitan-html k-selectable${
            onCrossRef ? " yomitan-xref" : ""
          }`}
          onClick={
            onCrossRef
              ? (e) => {
                  const target = crossRefTargetFromEvent(e, textLang);
                  if (target) {
                    e.preventDefault();
                    onCrossRef(target);
                  }
                }
              : undefined
          }
          dangerouslySetInnerHTML={{ __html: displayHtml(fields.glossary) }}
        />
      ) : null}

      {/* Frequencies */}
      {fields.frequencies ? (
        <div
          className="popover-frequencies yomitan-html k-num"
          dangerouslySetInnerHTML={{ __html: displayHtml(fields.frequencies) }}
        />
      ) : null}
    </article>
  );
}

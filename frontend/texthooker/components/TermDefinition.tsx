import { displayHtml } from "../lib/html";
import { Badge } from "@texthooker/components/ui/badge";
import { parseInflectionChains } from "@texthooker/lib/inflection";
import type { YomitanAnkiFields } from "@texthooker/lib/types";

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
 */
function crossRefTargetFromEvent(
  e: React.MouseEvent<HTMLElement>,
): string | null {
  let node: HTMLElement | null = e.target as HTMLElement;
  const container = e.currentTarget;
  while (node && node !== container) {
    if (node.tagName === "A") {
      const a = node as HTMLAnchorElement;
      // Yomitan's signature for an internal reference: a fragment href plus a
      // ja-tagged anchor. (Real external links would have a real href.)
      const href = a.getAttribute("href");
      if (a.lang === "ja" && (href === "#" || href === null || href === "")) {
        const text = (a.textContent ?? "").trim();
        return text || null;
      }
      return null;
    }
    node = node.parentElement;
  }
  return null;
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
  if (state === "loading") {
    return <div className="text-xs text-(--color-text-muted)">Looking up…</div>;
  }
  if (state === "error") {
    return (
      <div className="text-xs italic text-(--color-text-muted)">
        {errorMessage || "Lookup failed."}
      </div>
    );
  }
  if (state === "empty" || !fields) {
    return (
      <div className="text-xs italic text-(--color-text-muted)">
        No entries.
      </div>
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
  const inflectionChains = parseInflectionChains(fields.conjugation);

  return (
    <div className="text-sm leading-relaxed">
      {/* Headword */}
      <div className="jp-text flex items-baseline gap-1.5 flex-wrap border-b border-(--color-border) pb-1.5 mb-2">
        <span className="text-[1.375rem] font-bold">{expression}</span>
        {reading && reading !== expression ? (
          <span className="text-sm font-normal text-(--color-text-dim)">
            【{reading}】
          </span>
        ) : null}
        {actions ? (
          <span className="ml-auto flex items-center gap-1 self-center">
            {actions}
          </span>
        ) : null}
      </div>

      {/* Inflection chains (multiple = alternative deinflection paths) */}
      {inflectionChains.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 mb-2 text-[0.6875rem] text-(--color-text-dim)">
          <span className="opacity-60">inflected:</span>
          {inflectionChains.map((chain, ci) => (
            <span key={ci} className="inline-flex items-center gap-1">
              {ci > 0 ? (
                <span className="opacity-50 italic px-0.5">or</span>
              ) : null}
              {chain.map((step, i) => (
                <span
                  key={`${step.rule}-${i}`}
                  className="inline-flex items-center gap-1"
                >
                  <span
                    title={step.description ?? "Yomitan deinflection rule"}
                    className="inline-flex items-center rounded border border-(--color-border) bg-(--color-bg-elev-2) px-1.5 py-[1px] font-mono text-[0.625rem] text-(--color-text) cursor-help"
                  >
                    {step.rule}
                  </span>
                  {i < chain.length - 1 ? (
                    <span className="opacity-50">«</span>
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
          className="my-1.5"
          dangerouslySetInnerHTML={{ __html: displayHtml(fields["pitch-accents"]) }}
        />
      ) : null}

      {/* Badges */}
      {(dictionary || partsOfSpeech.length > 0 || tags.length > 0) && (
        <div className="flex flex-wrap gap-1 mb-2">
          {dictionary ? <Badge variant="accent">{dictionary}</Badge> : null}
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
          className={`yomitan-html jp-text text-[0.9375rem]${
            onCrossRef ? " yomitan-xref" : ""
          }`}
          onClick={
            onCrossRef
              ? (e) => {
                  const target = crossRefTargetFromEvent(e);
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
          className="yomitan-html mt-2 text-[0.6875rem] text-(--color-text-muted)"
          dangerouslySetInnerHTML={{ __html: displayHtml(fields.frequencies) }}
        />
      ) : null}
    </div>
  );
}

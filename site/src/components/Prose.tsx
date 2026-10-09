import type { ReactNode } from 'react'

export interface ProseProps {
  /** Page title (h1). */
  title: ReactNode
  /** Optional line under the title, e.g. a summary. */
  lede?: ReactNode
  /** Optional "Last updated" date string, shown as meta (e.g. "2026-10-09"). */
  updated?: string
  children?: ReactNode
}

/**
 * Long-form page layout (privacy, terms, compare). Write plain semantic HTML inside it: h2, h3,
 * p, ul/ol, a, table, blockquote, code. The `.prose-k` styles below handle rhythm and type.
 */
export function Prose({ title, lede, updated, children }: ProseProps) {
  return (
    <article className="container-page py-16 md:py-24">
      <div className="mx-auto max-w-prose">
        <header className="mb-10 border-b border-hairline pb-8">
          <h1 className="text-title text-ink">{title}</h1>
          {lede && <p className="mt-4 text-lede text-ink-2">{lede}</p>}
          {updated && (
            <p className="mt-4 text-meta text-ink-3 tnum">
              Last updated <time dateTime={updated}>{updated}</time>
            </p>
          )}
        </header>
        <div className="prose-k">{children}</div>
      </div>
    </article>
  )
}

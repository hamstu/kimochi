import type { ReactNode } from 'react'
import { routeMeta } from '../lib/seo.js'

export interface ProseProps {
  /** Page title (h1). */
  title: ReactNode
  /** Optional line under the title, e.g. a summary. */
  lede?: ReactNode
  /**
   * The page's route ("/faq"): its `published` and `updated` dates in ROUTES (src/lib/seo.js) are
   * shown under the title, the same dates as its JSON-LD and sitemap entry.
   */
  page?: string
  children?: ReactNode
}

/**
 * Long-form page layout (privacy, terms, compare). Write plain semantic HTML inside it: h2, h3,
 * p, ul/ol, a, table, blockquote, code. The `.prose-k` styles below handle rhythm and type.
 */
export function Prose({ title, lede, page, children }: ProseProps) {
  const { published, updated } = page ? routeMeta(page) : {}
  return (
    <article className="container-page py-16 md:py-24">
      <div className="mx-auto max-w-prose">
        <header className="mb-10 border-b border-hairline pb-8">
          <h1 className="text-title text-ink">{title}</h1>
          {lede && <p className="mt-4 text-lede text-ink-2">{lede}</p>}
          {(published || updated) && (
            <p className="mt-4 text-meta text-ink-3 tnum">
              {published && (
                <>
                  Published <time dateTime={published}>{published}</time>
                </>
              )}
              {published && updated && ' · '}
              {updated && (
                <>
                  Updated <time dateTime={updated}>{updated}</time>
                </>
              )}
            </p>
          )}
        </header>
        <div className="prose-k">{children}</div>
      </div>
    </article>
  )
}

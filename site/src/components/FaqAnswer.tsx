import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import type { FaqItem } from '../content/faq.js'

/**
 * One FAQ answer: its paragraphs, its links, and (in the dev server only) what Hamish still has to
 * fill in, marked TODO(hamish) so it is impossible to miss while editing.
 */
export function FaqAnswer({ item }: { item: FaqItem }) {
  return (
    <>
      {item.a.map((p) => (
        <p key={p}>{p}</p>
      ))}
      {item.links && (
        <p className="flex flex-wrap gap-x-5 gap-y-1">
          {item.links.map((l) =>
            l.href.startsWith('/') ? (
              <Link key={l.href} to={l.href} className="inline-flex items-center gap-1">
                {l.label}
                <ArrowRight size={14} aria-hidden />
              </Link>
            ) : (
              <a key={l.href} href={l.href} className="inline-flex items-center gap-1">
                {l.label}
                <ArrowRight size={14} aria-hidden />
              </a>
            )
          )}
        </p>
      )}
      {import.meta.env.DEV && item.todo && (
        <p className="rounded-md border border-dashed border-warn px-3 py-2 text-small text-warn">
          <strong className="text-warn">TODO(hamish):</strong> {item.todo}
        </p>
      )}
    </>
  )
}

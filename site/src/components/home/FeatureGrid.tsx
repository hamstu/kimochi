import { ArrowRight } from 'lucide-react'
import { features } from './features'
import { docsUrl } from '../../lib/docs.js'

/** The feature callouts: a drawn visual over the feature's name and a short body. */
export function FeatureGrid() {
  return (
    <ul className="grid gap-x-8 gap-y-14 md:grid-cols-2 md:gap-y-16">
      {features.map(({ id, title, body, Visual, docs }) => (
        <li key={id} className="flex flex-col">
          <Visual />
          <h3 className="mt-6 text-heading font-semibold text-ink">{title}</h3>
          <p className="mt-2 max-w-[52ch] text-body text-ink-2">{body}</p>
          {docs && (
            <a
              href={docsUrl(docs)}
              className="mt-2 inline-flex w-fit items-center gap-1 text-small font-medium text-accent-ink no-underline hover:underline"
            >
              How it works in the docs
              <ArrowRight size={14} aria-hidden />
            </a>
          )}
        </li>
      ))}
    </ul>
  )
}

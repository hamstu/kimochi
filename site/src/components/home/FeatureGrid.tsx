import { ArrowRight, Cloud } from 'lucide-react'
import { Link } from 'react-router'
import { features } from './features'
import { docsUrl } from '../../lib/docs.js'

const linkClass =
  'mt-2 inline-flex w-fit items-center gap-1 text-small font-medium text-accent-ink no-underline hover:underline'

/** The feature callouts: a drawn visual over the feature's name and a short body. */
export function FeatureGrid() {
  return (
    <ul className="grid gap-x-8 gap-y-14 md:grid-cols-2 md:gap-y-16">
      {features.map(({ id, title, body, Visual, docs, cloud, link }) => (
        <li key={id} className="flex flex-col">
          <Visual />
          <h3 className="mt-6 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-heading font-semibold text-ink">
            {title}
            {cloud && (
              // Echoes the "Kimochi Cloud" plan card's accent label in #open-source.
              <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-meta tracking-[0.04em] text-accent-ink">
                <Cloud size={12} aria-hidden />
                Kimochi Cloud
              </span>
            )}
          </h3>
          <p className="mt-2 max-w-[52ch] text-body text-ink-2">{body}</p>
          {link ? (
            <Link to={link.to} className={linkClass}>
              {link.label}
              <ArrowRight size={14} aria-hidden />
            </Link>
          ) : (
            docs && (
              <a href={docsUrl(docs)} className={linkClass}>
                How it works in the docs
                <ArrowRight size={14} aria-hidden />
              </a>
            )
          )}
        </li>
      ))}
    </ul>
  )
}

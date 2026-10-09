import { features } from './features'

/** The feature callouts: a drawn visual over a kicker, title and two-line body. */
export function FeatureGrid() {
  return (
    <ul className="grid gap-x-8 gap-y-14 md:grid-cols-2 md:gap-y-16">
      {features.map(({ id, kicker, title, body, Visual }) => (
        <li key={id} className="flex flex-col">
          <Visual />
          <p className="mt-6 text-meta tracking-[0.08em] text-accent-ink uppercase">{kicker}</p>
          <h3 className="mt-2 text-heading text-ink">{title}</h3>
          <p className="mt-2 max-w-[52ch] text-body text-ink-2">{body}</p>
        </li>
      ))}
    </ul>
  )
}

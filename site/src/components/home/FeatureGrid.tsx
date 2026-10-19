import { features } from './features'

/** The feature callouts: a drawn visual over the feature's name and a short body. */
export function FeatureGrid() {
  return (
    <ul className="grid gap-x-8 gap-y-14 md:grid-cols-2 md:gap-y-16">
      {features.map(({ id, title, body, Visual }) => (
        <li key={id} className="flex flex-col">
          <Visual />
          <h3 className="mt-6 text-heading font-semibold text-ink">{title}</h3>
          <p className="mt-2 max-w-[52ch] text-body text-ink-2">{body}</p>
        </li>
      ))}
    </ul>
  )
}

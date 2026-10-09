import { Section } from '../Section'
import { testimonials } from './testimonials'

/** Renders nothing until src/components/home/testimonials.ts has entries. */
export function Testimonials() {
  if (testimonials.length === 0) return null
  return (
    <Section id="testimonials" divider eyebrow="From readers" heading="What people are reading with it">
      <ul className="grid gap-6 md:grid-cols-3">
        {testimonials.map((t) => (
          <li key={`${t.name}-${t.quote.slice(0, 16)}`}>
            <figure className="flex h-full flex-col rounded-xl border border-hairline bg-bar p-6">
              <blockquote className="flex-1 text-body text-ink">
                <p>&ldquo;{t.quote}&rdquo;</p>
              </blockquote>
              <figcaption className="mt-5 text-small">
                {t.href ? (
                  <a href={t.href} className="font-medium text-ink no-underline hover:underline">
                    {t.name}
                  </a>
                ) : (
                  <span className="font-medium text-ink">{t.name}</span>
                )}
                {t.detail && <span className="block text-ink-3">{t.detail}</span>}
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </Section>
  )
}

import { ArrowRight } from 'lucide-react'
import { docsUrl } from '../../lib/docs.js'

const STEPS = [
  {
    n: '一',
    title: 'Pick what to read',
    body: 'A game, a manga, a video, any window or screen. Add a crop area if you want.'
  },
  {
    n: '二',
    title: 'Scan',
    body: "Press Scan, or turn on Auto OCR. Turn on the overlay if you're feeling funky. 😉"
  },
  {
    n: '三',
    title: 'Read',
    body: 'The text shows up right over your game, manga or video (when the overlay is enabled), and in the Log.'
  },
  {
    n: '四',
    title: 'Look stuff up',
    body: 'Hover a word. Hear it, save it, keep going. 🤘'
  }
]

export function HowItWorks() {
  return (
    <>
      <ol className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
        {STEPS.map((s, i) => (
          <li key={s.title} className="border-t border-hairline pt-5">
            <p className="flex items-baseline gap-2">
              <span lang="ja" className="text-[1.75rem] leading-none font-medium text-accent-ink">
                {s.n}
              </span>
              <span className="sr-only">Step {i + 1}:</span>
            </p>
            <h3 className="mt-4 text-heading text-ink">{s.title}</h3>
            <p className="mt-2 text-body text-ink-2">{s.body}</p>
          </li>
        ))}
      </ol>
      <p className="mt-10">
        <a
          href={docsUrl('/quick-start/')}
          className="inline-flex items-center gap-1 text-small font-medium text-accent-ink no-underline hover:underline"
        >
          The step-by-step quick start
          <ArrowRight size={14} aria-hidden />
        </a>
      </p>
    </>
  )
}

import { ArrowRight, ChevronDown } from 'lucide-react'
import { Button } from '../Button'
import { FaqAnswer } from '../FaqAnswer'
import { FAQ, HOME_FAQ_COUNT } from '../../content/faq.js'

/**
 * Questions from src/content/faq.js as disclosures, then a link to /faq. The first one (What is
 * Kimochi?) is skipped: WhatIsKimochi answers it near the top of the page.
 */
export function HomeFaq() {
  return (
    <div className="max-w-3xl">
      <div className="divide-y divide-hairline border-y border-hairline">
        {FAQ.slice(1, 1 + HOME_FAQ_COUNT).map((item) => (
          <details key={item.id} className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-4 text-heading text-ink [&::-webkit-details-marker]:hidden">
              <h3 className="text-heading">{item.q}</h3>
              <ChevronDown size={18} aria-hidden className="shrink-0 text-ink-3 transition-transform duration-150 group-open:rotate-180" />
            </summary>
            <div className="prose-k flex flex-col gap-3 pb-5 [&>*+*]:mt-0">
              <FaqAnswer item={item} />
            </div>
          </details>
        ))}
      </div>
      <Button href="/faq" variant="secondary" className="mt-8" icon={<ArrowRight size={16} aria-hidden />}>
        All questions
      </Button>
    </div>
  )
}

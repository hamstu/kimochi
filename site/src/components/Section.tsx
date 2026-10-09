import type { ReactNode } from 'react'

export interface SectionProps {
  /** Anchor id, e.g. "features" (header nav links to /#features, /#demo, /#download). */
  id?: string
  /** Small uppercase label above the heading. */
  eyebrow?: ReactNode
  /** Section heading (rendered as h2, text-title). */
  heading?: ReactNode
  /** Supporting paragraph under the heading (text-lede, ink-2, max ~60ch). */
  lede?: ReactNode
  /** Header alignment. Default "start". */
  align?: 'start' | 'center'
  /** Content width. narrow = 48rem, default = page (72rem), wide = full bleed inside gutters. */
  width?: 'narrow' | 'default' | 'wide'
  /** Background plane. "bar" gives a quiet band (slate-2) with hairlines top and bottom. */
  tone?: 'ground' | 'bar'
  /** Hairline above the section (ignored for tone="bar", which has its own). */
  divider?: boolean
  className?: string
  children?: ReactNode
}

/** One vertical rhythm for every home-page block: py-20 on phones, py-28 from md up. */
export function Section({
  id,
  eyebrow,
  heading,
  lede,
  align = 'start',
  width = 'default',
  tone = 'ground',
  divider = false,
  className = '',
  children
}: SectionProps) {
  const toneClass = tone === 'bar' ? 'bg-bar border-y border-hairline' : divider ? 'border-t border-hairline' : ''
  const inner = width === 'narrow' ? 'max-w-3xl' : width === 'wide' ? 'max-w-none' : ''
  const center = align === 'center'
  const hasHeader = eyebrow || heading || lede
  return (
    <section id={id} className={`py-20 md:py-28 ${toneClass} ${className}`}>
      <div className={`container-page ${inner}`}>
        {hasHeader && (
          <header className={`mb-10 md:mb-14 ${center ? 'mx-auto text-center' : ''} max-w-3xl`}>
            {eyebrow && (
              <p className="mb-3 text-meta uppercase tracking-[0.08em] text-accent-ink">{eyebrow}</p>
            )}
            {heading && <h2 className="text-title text-ink">{heading}</h2>}
            {lede && (
              <p className={`mt-4 max-w-[60ch] text-lede text-ink-2 ${center ? 'mx-auto' : ''}`}>{lede}</p>
            )}
          </header>
        )}
        {children}
      </div>
    </section>
  )
}

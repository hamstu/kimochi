import { LiveDemo } from '../../demo/LiveDemo'
import { useGuessedPlatform } from '../../demo/env'
import { PlatformStrip } from './PlatformStrip'

/**
 * "Runs on", then the live preview: a desktop dressed as the visitor's own OS, where Mochiko guides
 * them through Kimochi (OCR, look-ups, Anki, and Text hooking). `id="demo"` is the header nav's anchor.
 */
export function DemoShowcase() {
  const guessed = useGuessedPlatform()
  // A Steam Deck visitor gets the Linux desktop (Desktop Mode), for now.
  const desktop = guessed === 'deck' ? 'linux' : guessed
  return (
    <section id="demo" aria-labelledby="demo-heading">
      <PlatformStrip />
      <div className="container-page pt-16 pb-16 md:pt-24 md:pb-24">
        <header className="mb-8 md:mb-10">
          <p className="mb-3 text-meta tracking-[0.08em] text-accent-ink uppercase">デモを試す</p>
          <h2 id="demo-heading" className="text-title text-ink">
            Preview
          </h2>
          <p className="mt-3 max-w-[44rem] text-body text-ink-2">
            The demo game is in Japanese. Kimochi reads Korean, Chinese, Spanish, French and many other languages too
            (experimental).
          </p>
        </header>
        <LiveDemo platform={desktop} />
      </div>
    </section>
  )
}

import { DownloadButton } from '../DownloadButton'
import { DiscordButton } from '../DiscordButton'
import { useState } from 'react'
import { GlyphGlow } from './GlyphGlow'
import { LanguageFlipper } from './LanguageFlipper'

/**
 * The home hero: the app icon, wordmark, promise, lede, the download button and a quieter Discord
 * link, centred, over a glow of letters from many writing systems. The headline's last word flips
 * through languages (LanguageFlipper); screen readers hear "Read and play in any language".
 */
// Fades the glow out towards the bottom and thins it behind the headline and lede.
const GLOW_MASK = {
  maskImage:
    'radial-gradient(ellipse 40% 22% at 50% 52%, rgb(0 0 0 / 0.22), black 100%), linear-gradient(to bottom, black 45%, transparent 96%)',
  maskComposite: 'intersect'
} as const

export function Hero() {
  const [hovered, setHovered] = useState(false)
  return (
    // z-10 and no overflow clip here: the download button's menu hangs below the hero, over the demo.
    <section className="relative isolate z-10">
      {/* A glow of glyphs behind the top of the hero, fading out before the headline and lede. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <GlyphGlow className="absolute inset-x-0 top-0 h-[52rem] w-full md:h-[64rem]" style={GLOW_MASK} />
      </div>

      <div className="container-page flex flex-col items-center pt-16 pb-16 text-center md:pt-24 md:pb-24">
        <img
          src="/icon.svg"
          alt=""
          width={168}
          height={168}
          className="size-32 drop-shadow-[0_22px_34px_color-mix(in_oklab,var(--k-accent)_32%,transparent)] md:size-40"
        />
        <p className="mt-7 text-[1.375rem] font-semibold tracking-[-0.015em] text-ink">Kimochi</p>
        <h1
          className="mt-5 text-display text-ink"
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
        >
          Read and play in <span className="sr-only">any language</span>
          <span className="lf-line">
            <LanguageFlipper paused={hovered} />
          </span>
        </h1>
        <p className="mt-6 max-w-[44rem] text-lede text-ink-2">
          Kimochi is a free, open-source desktop app for language learners. It reads the text in your games, visual
          novels, manga and videos directly, or with OCR, so you can hover any word to look it up in your favorite
          dictionary and make flash cards for Anki. Built for Japanese, and now for the language you’re learning too
          (experimental).
        </p>
        {/* The demo's Easter egg scrolls back here (#get-kimochi). */}
        <div id="get-kimochi" className="mt-10 scroll-mt-24">
          <DownloadButton align="center" />
        </div>
        {/* The community, a step quieter than the download, under a short rule. */}
        <div className="mt-8 flex flex-col items-center gap-6">
          <span aria-hidden className="h-px w-24 bg-hairline" />
          <DiscordButton variant="secondary" />
        </div>
      </div>
    </section>
  )
}

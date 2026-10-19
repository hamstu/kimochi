import { DownloadButton } from '../DownloadButton'
import { KanaRain } from './KanaRain'

/**
 * The home hero: the app icon, wordmark, promise, lede and the download button, centred, over a
 * kana rain.
 */
// Fades the rain out towards the bottom and thins it behind the centred text.
const RAIN_MASK = {
  maskImage:
    'radial-gradient(ellipse 38% 55% at 50% 50%, rgb(0 0 0 / 0.3), black 100%), linear-gradient(to bottom, black 30%, transparent 95%)',
  maskComposite: 'intersect'
} as const

export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      {/* Kana rain behind the top of the hero, fading out before the headline and lede. */}
      <KanaRain className="absolute inset-x-0 top-0 -z-10 h-[34rem] w-full opacity-75 md:h-[40rem]" style={RAIN_MASK} />

      <div className="container-page flex flex-col items-center pt-16 pb-16 text-center md:pt-24 md:pb-24">
        <img
          src="/icon.svg"
          alt=""
          width={168}
          height={168}
          className="size-32 drop-shadow-[0_22px_34px_color-mix(in_oklab,var(--k-accent)_32%,transparent)] md:size-40"
        />
        <p className="mt-7 flex items-baseline gap-2.5 text-[1.375rem] font-semibold tracking-[-0.015em] text-ink">
          Kimochi
          <span lang="ja" className="text-small font-normal tracking-normal text-ink-3">
            気持ち
          </span>
        </p>
        <h1 className="mt-5 max-w-[18ch] text-display text-ink">Read your games in Japanese.</h1>
        <p className="mt-6 max-w-[44rem] text-lede text-ink-2">
          Kimochi grabs the Japanese off your screen and puts it back over the game. Hover a word
          to see what it means. No alt-tabbing.
        </p>
        {/* The demo's Easter egg scrolls back here (#get-kimochi). */}
        <div id="get-kimochi" className="mt-10 scroll-mt-24">
          <DownloadButton align="center" />
        </div>
      </div>
    </section>
  )
}

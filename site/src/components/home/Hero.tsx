import { GITHUB_URL } from '../Layout'
import { DownloadButton } from '../DownloadButton'

/**
 * The home hero: the app icon, wordmark, promise, lede and the download button, centred, over a
 * faint vertical 気持ち ("feeling", the name's origin) set in the Japanese face.
 */
export function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      {/* Backdrop: the name in Japanese, set vertically, barely there. */}
      <p
        lang="ja"
        aria-hidden
        className="pointer-events-none absolute top-6 right-[max(1rem,calc(50%-34rem))] -z-10 text-[clamp(7rem,4rem+12vw,13rem)] leading-none font-semibold text-hairline opacity-70 select-none [writing-mode:vertical-rl] max-sm:right-[-1.5rem] max-sm:opacity-50"
      >
        気持ち
      </p>
      {/* A soft indigo bloom behind the icon. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-8 left-1/2 -z-10 size-[36rem] -translate-x-1/2 rounded-full opacity-80 blur-3xl"
        style={{ background: 'radial-gradient(closest-side, var(--k-accent-soft), transparent)' }}
      />

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
          Kimochi reads the text on screen and lays it back over the game. Every line goes into a
          log, where any word is a click from its meaning, its sound and an Anki card.
        </p>
        <DownloadButton align="center" showAll={false} className="mt-10" />
        <a
          href={GITHUB_URL}
          className="mt-3 text-small text-ink-3 underline decoration-hairline underline-offset-4 hover:text-ink-2 hover:decoration-current"
        >
          Source on GitHub
        </a>
      </div>
    </section>
  )
}

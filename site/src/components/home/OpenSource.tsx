import { Check, Plus } from 'lucide-react'
import { GITHUB_URL } from '../Layout'
import { Button } from '../Button'
import { useSession } from '../../lib/session'

/** Everything in Kimochi itself: free, no account, no limits. */
const FREE = [
  'The overlay, Auto OCR and Mini mode',
  'On-device and online OCR engines',
  'The Log, Sessions and the Notebook',
  'Yomitan, Hachidori, 10ten or your own Yomitan',
  'Anki cards in one click',
  'Gaming Mode on the Steam Deck'
]

/** What an account's paid plan adds: the parts that cost money to run. */
const CLOUD = [
  'Translation of any line, right in the app',
  'Read aloud in high-quality ElevenLabs voices',
  'Cloud OCR for the hardest text',
  'Sync of your logs and notebook across devices'
]

/**
 * Free and open source: the GPL licence, and the optional paid plan side by side with what is free,
 * so it is plain the plan is extra. The price is a placeholder until pricing is set.
 */
export function OpenSource() {
  const { status } = useSession()
  const signedIn = status === 'signed-in'
  return (
    <div className="grid gap-5 md:grid-cols-2">
      <div className="flex flex-col rounded-2xl border border-hairline bg-raised p-6 md:p-8">
        <p className="text-meta tracking-[0.08em] text-ink-3 uppercase">Kimochi</p>
        <p className="mt-3 flex items-baseline gap-2">
          <span className="text-[2.5rem] leading-none font-semibold tracking-[-0.02em] text-ink">Free</span>
          <span className="text-small text-ink-3">forever</span>
        </p>
        <p className="mt-3 text-body text-ink-2">Everything you need to read your games. No account, no limits.</p>
        <ul className="mt-6 flex flex-col gap-2.5">
          {FREE.map((item) => (
            <li key={item} className="flex gap-2.5 text-body text-ink">
              <Check size={18} className="mt-0.5 shrink-0 text-ok" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
        <a
          href={GITHUB_URL}
          className="mt-auto pt-7 text-small text-ink-3 underline decoration-hairline underline-offset-4 hover:text-ink-2 hover:decoration-current"
        >
          Source on GitHub, under the GPL-3.0 licence
        </a>
      </div>

      <div className="relative flex flex-col overflow-hidden rounded-2xl border border-[color-mix(in_oklab,var(--k-accent)_40%,transparent)] bg-[color-mix(in_oklab,var(--k-accent)_7%,var(--k-raised))] p-6 md:p-8">
        <div className="flex items-center justify-between gap-3">
          <p className="text-meta tracking-[0.08em] text-accent-ink uppercase">Kimochi Cloud</p>
          <span className="rounded-full border border-hairline px-2.5 py-0.5 text-meta text-ink-2">Optional</span>
        </div>
        <p className="mt-3 flex items-baseline gap-1.5">
          <span className="text-[2.5rem] leading-none font-semibold tracking-[-0.02em] text-ink tnum">$5</span>
          <span className="text-small text-ink-3">a month</span>
        </p>
        <p className="mt-3 text-body text-ink-2">A few extras that cost money to run, with a Kimochi account.</p>
        <ul className="mt-6 flex flex-col gap-2.5">
          <li className="flex gap-2.5 text-body text-ink-2">
            <Check size={18} className="mt-0.5 shrink-0 text-ok" aria-hidden />
            Everything in Kimochi, of course
          </li>
          {CLOUD.map((item) => (
            <li key={item} className="flex gap-2.5 text-body text-ink">
              <Plus size={18} className="mt-0.5 shrink-0 text-accent-ink" aria-hidden />
              {item}
            </li>
          ))}
        </ul>
        {/* An account can be made here before Kimochi is installed; the app signs in to it later. */}
        <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2 pt-7">
          <Button href={signedIn ? '/account' : '/account/sign-up'} size="lg">
            {signedIn ? 'Go to your account' : 'Create an account'}
          </Button>
          {!signedIn && <span className="text-small text-ink-3">Free to create. Sign in from the app any time.</span>}
        </div>
      </div>
    </div>
  )
}

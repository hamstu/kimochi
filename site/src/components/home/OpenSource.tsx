import { useState } from 'react'
import { AppWindow, ArrowRight, AudioLines, BookOpenText, ChevronDown, FishingHook, Lightbulb, ScanText, Type, type LucideIcon } from 'lucide-react'
import { ACKNOWLEDGEMENTS, NOTICE_URL, creditIcon, type Acknowledgement, type CreditGroupIcon } from '@kimochi/credits/credits'
import '@kimochi/credits/credits.css'
import { GITHUB_URL } from '../Layout'
import { Button } from '../Button'
import { GithubMark } from '../PlatformMarks'

const GROUP_ICONS: Record<CreditGroupIcon, LucideIcon> = {
  BookOpenText,
  ScanText,
  FishingHook,
  AudioLines,
  Lightbulb,
  AppWindow,
  Type
}

/** A heading id for a group: 'Text recognition' → 'credits-text-recognition'. */
function slug(title: string): string {
  return `credits-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
}

/** A project's tile: its logo on a pale badge, or an emoji on a tint (credits.css). */
function CreditTile({ id }: { id: string }) {
  const icon = creditIcon(id)
  if ('src' in icon) {
    return (
      <span aria-hidden className={`credit-tile ${icon.tint ? `credit-tint-${icon.tint}` : ''}`} data-logo="">
        <img src={icon.src} alt="" loading="lazy" decoding="async" />
      </span>
    )
  }
  return (
    <span aria-hidden className={`credit-tile credit-tint-${icon.tint}`}>
      {icon.emoji}
    </span>
  )
}

/** One project: its tile, name and licence, what Kimochi uses it for; the name links to it. */
function Credit({ item }: { item: Acknowledgement }) {
  return (
    <li className="flex items-start gap-3 border-b border-hairline py-3">
      <CreditTile id={item.id} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <a href={item.url} className="text-small font-medium text-ink no-underline hover:underline">
            {item.name}
          </a>
          <span className="shrink-0 text-right text-meta text-ink-3">{item.license}</span>
        </span>
        <span className="block text-small text-ink-3">{item.role}</span>
      </span>
    </li>
  )
}

/** On phones, the groups shown before "Show all": the list is long there, one column. */
const PHONE_GROUPS = 2

/**
 * Open source: the code on GitHub, a thank-you note, then the projects Kimochi is built on and
 * inspired by, from the list the app's Settings → About shows too (frontend/credits, imported as
 * `@kimochi/credits`), with NOTICE for the rest.
 */
export function OpenSource() {
  const [all, setAll] = useState(false)
  const total = ACKNOWLEDGEMENTS.reduce((n, group) => n + group.items.length, 0)
  return (
    <>
      <Button href={GITHUB_URL} size="lg" icon={<GithubMark className="size-[18px]" />}>
        See the code on GitHub
      </Button>

      {/* A note pinned above the credits. */}
      <div className="mt-14 md:mt-20">
        <div className="credits-note relative max-w-md -rotate-2 rounded-sm px-6 pt-7 pb-6 shadow-[0_14px_30px_-12px_rgb(0_0_0/0.35)]">
          <span aria-hidden className="credits-note-tape absolute -top-2.5 left-1/2 h-5 w-20 -translate-x-1/2 rotate-3" />
          <h3 className="text-heading font-semibold">
            Standing on the shoulders of giants <span aria-hidden>🙏</span>
          </h3>
          <p className="mt-2 text-body">
            Kimochi is built on, and inspired by many of these open-source projects. Thank you to everyone who made
            and shares them. ❤️
          </p>
        </div>
      </div>

      <div className="mt-12 flex flex-col gap-10">
        {ACKNOWLEDGEMENTS.map((group, i) => {
          const Icon = GROUP_ICONS[group.icon]
          return (
            <section
              key={group.title}
              className={!all && i >= PHONE_GROUPS ? 'max-md:hidden' : ''}
              aria-labelledby={slug(group.title)}
            >
              <h4 id={slug(group.title)} className="flex items-center gap-2.5 text-meta tracking-[0.08em] text-ink-2 uppercase">
                <Icon size={16} className="text-ink-3" aria-hidden />
                {group.title}
                <span aria-hidden className="h-px flex-1 bg-hairline" />
              </h4>
              <ul className="mt-2 grid gap-x-10 md:grid-cols-2">
                {group.items.map((item) => (
                  <Credit key={item.id} item={item} />
                ))}
              </ul>
            </section>
          )
        })}
      </div>

      {!all && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="mt-10 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-field text-small font-medium text-ink shadow-[inset_0_0_0_1px_var(--k-line-strong)] hover:bg-hover md:hidden"
        >
          Show all {total} projects
          <ChevronDown size={16} aria-hidden />
        </button>
      )}

      <a
        href={NOTICE_URL}
        className="mt-8 inline-flex items-center gap-1.5 text-small text-ink-2 underline decoration-hairline underline-offset-4 hover:text-ink hover:decoration-current"
      >
        Exact versions and full licence texts in NOTICE
        <ArrowRight size={14} aria-hidden />
      </a>
    </>
  )
}

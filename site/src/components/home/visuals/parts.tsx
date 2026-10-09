import type { CSSProperties, ReactNode } from 'react'

/**
 * Shared pieces for the feature visuals: stylised, honest miniatures of Kimochi's real windows,
 * drawn with the site tokens so they follow light and dark mode. Each visual renders inside a
 * <VisualFrame> (a fixed-height sunken well) and is decorative: the feature text carries the
 * meaning, so frames are aria-hidden.
 *
 * To swap a drawing for a real screenshot later, replace the visual's body with an <img> inside
 * the same <VisualFrame>.
 */

/** The sunken well every feature visual sits in. Fixed height keeps the grid even. */
export function VisualFrame({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div
      aria-hidden
      className={`relative flex h-64 items-center justify-center overflow-hidden rounded-xl border border-hairline bg-sunken px-4 select-none ${className}`}
    >
      {children}
    </div>
  )
}

/** A small app-drawn window: quiet title bar, raised body. Platform-neutral chrome, like the app. */
export function MiniWindow({
  title,
  children,
  className = '',
  trailing
}: {
  title: ReactNode
  children: ReactNode
  className?: string
  trailing?: ReactNode
}) {
  return (
    <div className={`overflow-hidden rounded-lg border border-hairline bg-raised shadow-pop ${className}`}>
      <div className="flex h-7 items-center gap-2 border-b border-hairline bg-bar px-2.5 text-[11px] font-medium text-ink-2">
        <span className="flex gap-1" aria-hidden>
          <span className="size-2 rounded-full bg-press" />
          <span className="size-2 rounded-full bg-press" />
        </span>
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {trailing}
      </div>
      {children}
    </div>
  )
}

/**
 * The game. A game frame looks the same whatever the site theme, so it is a dark, indigo-tinted
 * scene derived from the accent token rather than a theme role.
 */
export const gameSceneStyle: CSSProperties = {
  background:
    'radial-gradient(120% 90% at 78% 8%, color-mix(in oklab, var(--k-accent) 45%, transparent), transparent 60%),' +
    'linear-gradient(165deg, color-mix(in oklab, var(--k-accent) 30%, black) 0%, color-mix(in oklab, var(--k-accent) 8%, black) 100%)'
}

export function GameScene({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return (
    <div className={`relative overflow-hidden rounded-lg shadow-pop ${className}`} style={gameSceneStyle}>
      {children}
    </div>
  )
}

/** A small on/off switch in the app's style. */
export function MiniSwitch({ on }: { on: boolean }) {
  return (
    <span
      className={`relative inline-flex h-3.5 w-6 shrink-0 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-press'}`}
    >
      <span
        className={`absolute top-0.5 size-2.5 rounded-full bg-accent-contrast shadow-sm ${on ? 'left-3' : 'left-0.5'}`}
      />
    </span>
  )
}

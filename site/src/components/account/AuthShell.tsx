import { useEffect, useRef, type ReactNode } from 'react'

export interface AuthShellProps {
  title: ReactNode
  lede?: ReactNode
  /** Narrow (sign-in forms) or default (link confirmation). */
  width?: 'narrow' | 'default'
  children?: ReactNode
  /** Quiet line(s) under the card: "No account? Create one". */
  footer?: ReactNode
}

/**
 * A small centred page for the auth flows (sign-in, sign-up, reset, verify, link). Moves focus to
 * the heading on mount so screen readers announce the new page after a client-side navigation.
 */
export function AuthShell({ title, lede, width = 'narrow', children, footer }: AuthShellProps) {
  const heading = useRef<HTMLHeadingElement>(null)
  // Re-run when a page swaps its title (e.g. /link moving from "confirm" to "signed in").
  const titleKey = typeof title === 'string' ? title : null
  useEffect(() => {
    heading.current?.focus({ preventScroll: true })
  }, [titleKey])
  return (
    <section className="container-page py-14 md:py-20">
      <div className={`mx-auto ${width === 'narrow' ? 'max-w-[26rem]' : 'max-w-[34rem]'}`}>
        <h1 ref={heading} tabIndex={-1} className="text-title text-ink outline-none">
          {title}
        </h1>
        {lede && <div className="mt-3 text-ink-2">{lede}</div>}
        <div className="mt-8">{children}</div>
        {footer && <div className="mt-8 border-t border-hairline pt-6 text-small text-ink-2">{footer}</div>}
      </div>
    </section>
  )
}

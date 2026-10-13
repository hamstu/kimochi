/**
 * One onboarding step's content: a heading, a lede and the step's body, in one calm column. The
 * step's buttons go in the window's action bar (`StepActions`), not here.
 */
import type { JSX, ReactNode } from 'react'
import style from './WelcomeApp.module.css'

export default function Step({
  title,
  lede,
  children,
  centered = false,
  labelledBy
}: {
  title: ReactNode
  lede?: ReactNode
  children?: ReactNode
  /** Centre the column vertically (short steps: the intro, the last step). */
  centered?: boolean
  labelledBy?: string
}): JSX.Element {
  const id = labelledBy ?? 'step-title'
  return (
    <section
      className={style.step}
      data-centered={centered || undefined}
      aria-labelledby={id}
    >
      <header className={style.header}>
        <h1 id={id} className={style.title}>
          {title}
        </h1>
        {lede && <p className={style.lede}>{lede}</p>}
      </header>
      {children}
    </section>
  )
}

/**
 * The first step: the icon builds itself, then the name and the promise, then Get started.
 *
 * About 2.2 s in all. A click anywhere (or Get started) during it jumps to the finished state;
 * Get started then goes on. Reduced motion, and any return to this step in the same session,
 * shows the finished state at once.
 */
import { useEffect, useState, type JSX } from 'react'
import { useNavigate } from 'react-router'
import { Button } from '@kit'
import KimochiLogo from '../components/KimochiLogo'
import { StepActions } from './StepActions'
import style from './WelcomeApp.module.css'

/** When the intro's last element (the lede) has finished arriving. */
export const INTRO_MS = 2200

let played = false

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export default function IntroStep({ next }: { next: string }): JSX.Element {
  const navigate = useNavigate()
  const [settled, setSettled] = useState(() => played || reducedMotion())
  useEffect(() => {
    if (settled) {
      played = true
      return
    }
    const timer = setTimeout(() => setSettled(true), INTRO_MS)
    return () => clearTimeout(timer)
  }, [settled])

  return (
    <section
      className={style.intro}
      data-settled={settled || undefined}
      aria-labelledby="intro-title"
      onClick={() => setSettled(true)}
    >
      <KimochiLogo size={136} animate settled={settled} className={style.introLogo} />
      <h1 id="intro-title" className={style.wordmark}>
        Kimochi
      </h1>
      <p className={style.tagline}>Read and play in Japanese.</p>
      <p className={style.introLede}>
        Kimochi reads the text on your screen and puts every word a hover away from its meaning.
        A few quick choices and you are ready.
      </p>
      <StepActions>
        <Button
          variant="primary"
          className={style.introAction}
          data-arriving={settled ? undefined : ''}
          onClick={() => (settled ? void navigate(next) : setSettled(true))}
        >
          Get started
        </Button>
      </StepActions>
    </section>
  )
}

/**
 * The interactive demo on the home page.
 *
 * Desktop platforms: a synthetic visual novel (GameScreen, original CSS/SVG art) in a decorated game
 * window, with Kimochi's overlay drawn over it, beside the REAL Log window: the app's React UI built
 * from the preview harness (vite.demo.config.ts → /demo/panel.html) with the Tauri runtime mocked,
 * embedded in an iframe and driven by postMessage, so each line the game shows arrives in the Log.
 *
 * Steam Deck: one handheld screen and the controller flow (both sticks → radial menu → Scan → D-pad
 * word to word → A reads → B back).
 *
 * The example game comes from frontend/dev/demo-content.ts (shared with the harness). The run pauses
 * offscreen and in hidden tabs, and with prefers-reduced-motion shows one still frame, popup open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GAME } from './content'
import { guessPlatform, useOnScreen, useReducedMotion, useResolvedTheme, type Platform } from './env'
import { deckFrames, desktopFrames, usePlayer, type Frame } from './script'
import { GameScreen } from './GameScreen'
import { DeckBody, DeckHud } from './DeckStage'
import { LogFrame, type PostToLog } from './LogFrame'
import { DesktopBar, Taskbar, TitleBar, WINDOW_SHAPE } from './chrome'
import { PlatformTabs } from './PlatformTabs'
import { PLAY_LINES } from './content'
import './demo.css'

export interface LiveDemoProps {
  className?: string
  /** Initial platform tab; defaults to the visitor's OS. */
  platform?: Platform
}

const DESKTOP_FRAMES = desktopFrames()
const DECK_FRAMES = deckFrames()

/** The still frame for reduced motion: the first line, boxes up, popup open. */
function stillFrame(frames: Frame[]): Frame {
  return frames.find((f) => f.popup) ?? frames[0]
}

export function LiveDemo({ className = '', platform: initial }: LiveDemoProps) {
  const [platform, setPlatform] = useState<Platform>(() => initial ?? guessPlatform())
  const theme = useResolvedTheme()
  const reduced = useReducedMotion()
  const stageRef = useRef<HTMLDivElement>(null)
  const onScreen = useOnScreen(stageRef, '0px')
  const near = useOnScreen(stageRef, '600px')
  const [loadLog, setLoadLog] = useState(false)
  useEffect(() => {
    if (near) setLoadLog(true)
  }, [near])

  const [userCursor, setUserCursor] = useState<number | null>(null)
  const deck = platform === 'deck'
  const frames = deck ? DECK_FRAMES : DESKTOP_FRAMES
  const postRef = useRef<PostToLog | null>(null)

  const onEnter = useCallback((frame: Frame) => {
    if (frame.emit === 'scan') postRef.current?.({ type: 'scan' })
    if (frame.emit === 'line') postRef.current?.({ type: 'line', text: PLAY_LINES[frame.line].text })
  }, [])

  const running = onScreen && !reduced && userCursor === null
  const playing = usePlayer(frames, running, onEnter, platform)
  const frame = reduced ? stillFrame(frames) : playing

  // A visitor's pick belongs to the line it was made on.
  useEffect(() => setUserCursor(null), [frame.line, platform])

  const choose = (p: Platform): void => {
    setUserCursor(null)
    setPlatform(p)
  }

  const screen = useMemo(
    () => (
      <GameScreen
        frame={frame}
        variant={deck ? 'deck' : 'desktop'}
        paused={!onScreen}
        userCursor={userCursor}
        onUserCursor={setUserCursor}
      >
        {deck && <DeckHud frame={frame} />}
      </GameScreen>
    ),
    [frame, deck, onScreen, userCursor]
  )

  return (
    <div className={`w-full ${className}`}>
      <PlatformTabs value={platform} onChange={choose} />
      <div
        ref={stageRef}
        className="kd-stage relative mt-4 flex w-full flex-col overflow-hidden rounded-xl border border-hairline lg:aspect-[16/10]"
      >
        {deck ? (
          <div className="grid flex-1 place-items-center px-3 py-8 sm:px-8 lg:px-14">
            <DeckBody frame={frame}>{screen}</DeckBody>
          </div>
        ) : (
          <>
            <DesktopBar platform={platform} />
            <div className="grid min-h-0 flex-1 gap-4 p-3 sm:p-5 lg:grid-cols-[1.75fr_1fr] lg:grid-rows-[minmax(0,1fr)] lg:items-center lg:gap-5 lg:p-6">
              <div className={`min-w-0 overflow-hidden ${WINDOW_SHAPE[platform]}`}>
                <TitleBar
                  platform={platform}
                  title={GAME.app}
                  icon={<span className="kd-game-icon block size-3.5 rounded-[3px]" aria-hidden="true" />}
                />
                {screen}
              </div>
              <LogFrame
                platform={platform}
                theme={theme}
                load={loadLog}
                postRef={postRef}
                className="h-[440px] min-h-0 lg:h-full"
              />
            </div>
            {platform === 'windows' && <Taskbar />}
          </>
        )}
      </div>
      <p className="mt-3 text-meta text-ink-3">
        {deck
          ? 'Steam Deck: press both sticks for the Kimochi menu, Scan, step through words with the D-pad, A to read, B to go back.'
          : 'The game is a drawing. The Log beside it is the real Kimochi window running in your browser; hover a boxed word to look it up, or press Try it to use the Log.'}
      </p>
    </div>
  )
}

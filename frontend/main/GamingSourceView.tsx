/**
 * Gaming Mode's Source view (Steam Deck): the first thing Kimochi shows there, in place of the
 * desktop sidebar. Three columns, left to right, in the order a reader sets up:
 *
 *  1. the game: the same Source card as the sidebar (choose it, crop it, see it live);
 *  2. how it is read: the same controls the sidebar puts under the card (Scan, Auto OCR, Enhance
 *     Anki cards), then the OCR model and the dictionary;
 *  3. what to do next: choose a game, switch to it with Steam's own button, then open the game
 *     menu in the game. Each step lights up once the one before it is done.
 *
 * Kimochi does not switch to the game itself: Gamescope only hands a game the input properly when
 * Steam switches to it, so the third column says how to.
 */
import type { JSX, ReactNode } from 'react'
import { Check } from 'lucide-react'
import { Kbd } from '@kit'
import { useHotkeys } from '../bridge/useHotkeys'
import { getButtonName } from '../bridge/useGamepad'
import type { ControllerWiring } from '../panels/useController'
import { SourcePanel } from './SourcePanel'
import { DictionaryPicker, OcrModel } from './MainSidebar'

/** Steam's own button, drawn as the Deck labels it. */
export function SteamButton(): JSX.Element {
  return (
    <span className="gm-steam-button" role="img" aria-label="Steam button">
      STEAM
    </span>
  )
}

/** The buttons that open the game menu, as their names, or none when it has no button. */
function useMenuButtons(): string[] {
  const [hotkeys] = useHotkeys()
  const binding = hotkeys.openControllerMenu
  if (binding?.enabled === false) return []
  const buttons =
    binding?.gamepadButtons ?? (Number.isInteger(binding?.gamepadButton) ? [binding.gamepadButton as number] : [])
  return buttons.map(getButtonName)
}

function Step({
  number,
  title,
  done,
  active,
  children
}: {
  number: number
  title: string
  done: boolean
  active: boolean
  children: ReactNode
}): JSX.Element {
  return (
    <li className="gm-step" data-done={done || undefined} data-active={active || undefined}>
      <span className="gm-step-mark" aria-hidden>
        {done ? <Check /> : number}
      </span>
      <div className="gm-step-text">
        <span className="gm-step-title">{title}</span>
        <div className="gm-step-body">{children}</div>
      </div>
    </li>
  )
}

/** The third column: what to do now, from what is set up so far. */
export function GamingNextSteps({ sourceName }: { sourceName: string | null }): JSX.Element {
  const menu = useMenuButtons()
  const chosen = sourceName !== null
  return (
    <ol className="gm-steps" aria-label="What to do next">
      <Step number={1} title="Choose your game" done={chosen} active={!chosen}>
        {chosen ? <>Reading {sourceName}.</> : <>Start your game in Steam, then choose it on the left.</>}
      </Step>
      <Step number={2} title="Go back to your game" done={false} active={chosen}>
        Press <SteamButton /> and choose {sourceName ?? 'your game'}.
      </Step>
      <Step number={3} title="Read in your game" done={false} active={chosen}>
        {menu.length > 0 ? (
          <>
            Press{' '}
            {menu.map((name, index) => (
              <span key={name}>
                {index > 0 && ' + '}
                <Kbd>{name}</Kbd>
              </span>
            ))}{' '}
            for the game menu, then Scan.
          </>
        ) : (
          <>Choose a button for the game menu in Settings → Shortcuts &amp; Controls.</>
        )}
      </Step>
    </ol>
  )
}

export function GamingSourceView({
  controller,
  onOpenSettings,
  chooseRequest
}: {
  controller: ControllerWiring['props']
  onOpenSettings: (tab: 'sources' | 'ocr' | 'dictionary') => void
  chooseRequest: number
}): JSX.Element {
  const source = controller.currentSource
  const sourceName = source ? source.appName || source.name || 'your game' : null
  return (
    <div className="gm-source" role="tabpanel" aria-label="Source">
      <section className="gm-column" aria-labelledby="gm-game">
        <h2 className="gm-column-title" id="gm-game">
          Game
        </h2>
        <SourcePanel
          controller={controller}
          onOpenSettings={() => onOpenSettings('sources')}
          chooseRequest={chooseRequest}
          parts="card"
        />
      </section>
      <section className="gm-column" aria-labelledby="gm-reading">
        <h2 className="gm-column-title" id="gm-reading">
          Reading
        </h2>
        {source ? (
          <SourcePanel controller={controller} onOpenSettings={() => onOpenSettings('sources')} parts="controls" />
        ) : (
          <p className="gm-column-note">Choose a game first.</p>
        )}
        <OcrModel onOpenSettings={() => onOpenSettings('ocr')} />
        <DictionaryPicker onOpenSettings={() => onOpenSettings('dictionary')} />
      </section>
      <section className="gm-column gm-column-next" aria-labelledby="gm-next">
        <h2 className="gm-column-title" id="gm-next">
          Next
        </h2>
        <GamingNextSteps sourceName={sourceName} />
      </section>
    </div>
  )
}

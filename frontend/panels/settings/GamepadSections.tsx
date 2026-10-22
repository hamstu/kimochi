/** Settings → Shortcuts & Controls, second half: enable gamepad input, pick the primary controller, test it. */
import type { ReactNode } from 'react'
import { Badge, Button, Callout, SettingsRow, SettingsSection, Switch } from '@kit'
import { useGamepad, getButtonName } from '../../bridge/useGamepad'
import { useSetting } from '../../bridge/useSetting'
import { GamepadButtonCapture } from '../../components/GamepadButtonCapture'
import {
  DEFAULT_CONTROLLER_BUTTONS,
  effectiveControllerButtons,
  sharedButtonActions,
  type ControllerButtons
} from '@ui/settings'

/** The controller's command buttons, in the order the rows show them, by where they act. */
const BUTTON_GROUPS: {
  title: string
  description: string
  rows: { key: keyof ControllerButtons; label: string; description: string }[]
}[] = [
  {
    title: 'Controller menu',
    description:
      'Buttons used while the controller menu or the dictionary is open. The D-pad moves between items and words.',
    rows: [
      {
        key: 'confirm',
        label: 'Select',
        description:
          'Choose a menu item. On a word, move into the dictionary pop-up to use its buttons; there, press the chosen button.'
      },
      {
        key: 'back',
        label: 'Back',
        description: 'Close the menu, leave the pop-up for the text, or leave the dictionary for the game.'
      }
    ]
  },
  {
    title: 'Reading',
    description:
      'While stepping through the text. The left stick moves a free cursor that looks up the character it rests on; the right stick scrolls the pop-up.',
    rows: [
      {
        key: 'toggleUnit',
        label: 'Word or character',
        description: 'Step by word, or by character to start a lookup anywhere in a word.'
      },
      {
        key: 'playAudio',
        label: 'Play audio',
        description: "Play the word's pronunciation from the dictionary pop-up."
      },
      {
        key: 'previousDefinition',
        label: 'Previous definition',
        description: 'Jump up the dictionary pop-up to the definition before.'
      },
      {
        key: 'nextDefinition',
        label: 'Next definition',
        description: 'Jump down the dictionary pop-up to the next definition.'
      },
      {
        key: 'showControls',
        label: 'Show all controls',
        description: 'A list of every control, over the game.'
      }
    ]
  }
]

const ROW_LABELS = Object.fromEntries(
  BUTTON_GROUPS.flatMap((group) => group.rows.map((row) => [row.key, row.label]))
) as Record<keyof ControllerButtons, string>

/** The other actions bound to the same button as `key`, by label. */
function sharedWith(buttons: ControllerButtons, key: keyof ControllerButtons): string[] {
  return sharedButtonActions(buttons, key).map((other) => ROW_LABELS[other])
}

export function GamepadSections(): ReactNode {
  const {
    state: gamepadState,
    settings: gamepadSettings,
    setEnabled: setGamepadEnabled,
    setPreferredGamepad,
    source: gamepadSource
  } = useGamepad()

  const [storedButtons, setMenuButtons] = useSetting<ControllerButtons>(
    'controllerButtons',
    DEFAULT_CONTROLLER_BUTTONS
  )
  const menuButtons = effectiveControllerButtons(storedButtons)
  const customised = (Object.keys(DEFAULT_CONTROLLER_BUTTONS) as (keyof ControllerButtons)[]).some(
    (key) => menuButtons[key] !== DEFAULT_CONTROLLER_BUTTONS[key]
  )

  const enabled = gamepadSettings.enabled
  const gamepads = gamepadState.gamepads

  return (
    <>
      <SettingsSection title="Gamepad">
        <SettingsRow
          label="Enable gamepad support"
          controlId="gamepad-enabled"
          description="Use a gamepad controller to trigger shortcuts and scans."
        >
          <Switch
            id="gamepad-enabled"
            checked={enabled}
            onCheckedChange={(checked) => setGamepadEnabled(checked)}
          />
        </SettingsRow>
        {enabled && gamepadSource === 'none' && (
          <div className="settings-note">
            <Callout tone="warn">
              No gamepad input has been received yet in this build. Gamepad support has not been
              verified on this platform, so treat these controls as unconfirmed until a button
              lights up in the test below.
            </Callout>
          </div>
        )}
      </SettingsSection>

      {enabled &&
        BUTTON_GROUPS.map((group, index) => (
          <SettingsSection
            key={group.title}
            title={group.title}
            description={group.description}
            actions={
              index === 0 && customised ? (
                <Button
                  size="sm"
                  onClick={() => void setMenuButtons({ ...DEFAULT_CONTROLLER_BUTTONS })}
                >
                  Restore defaults
                </Button>
              ) : undefined
            }
          >
            {group.rows.map(({ key, label, description }) => {
              const shared = sharedWith(menuButtons, key)
              return (
                <SettingsRow
                  key={key}
                  label={label}
                  description={description}
                  badge={
                    shared.length > 0 ? (
                      <Badge tone="warn">Same as {shared.join(', ')}</Badge>
                    ) : undefined
                  }
                >
                  <GamepadButtonCapture
                    value={menuButtons[key] ?? undefined}
                    onChange={(button) =>
                      void setMenuButtons({ ...menuButtons, [key]: button ?? null })
                    }
                    size="1"
                  />
                </SettingsRow>
              )
            })}
          </SettingsSection>
        ))}

      {enabled && (
        <SettingsSection title="Connected gamepads">
          {gamepads.length === 0 ? (
            <SettingsRow
              label="No gamepads detected"
              description="Connect a controller and press any button."
            />
          ) : (
            gamepads.map((gp) => {
              const active = gp.index === gamepadState.activeGamepadIndex
              return (
                <SettingsRow
                  key={gp.index}
                  label={gp.id.split('(')[0].trim() || `Gamepad ${gp.index + 1}`}
                  badge={active ? <Badge tone="ok">Active</Badge> : undefined}
                  description={
                    <span className="k-num">
                      {gp.buttons} buttons, {gp.axes} axes
                    </span>
                  }
                >
                  {!active && (
                    <Button size="sm" onClick={() => setPreferredGamepad(gp.index)}>
                      Set as primary
                    </Button>
                  )}
                </SettingsRow>
              )
            })
          )}
        </SettingsSection>
      )}

      {enabled && gamepads.length > 0 && (
        <SettingsSection
          title="Button test"
          description="Press buttons on your controller to see them light up."
        >
          <div className="gamepad-test" role="group" aria-label="Button test">
            {gamepadState.buttonStates.map((pressed, index) => (
              <span key={index} className="gamepad-key" data-pressed={pressed ? '' : undefined}>
                {getButtonName(index)}
              </span>
            ))}
          </div>
        </SettingsSection>
      )}
    </>
  )
}

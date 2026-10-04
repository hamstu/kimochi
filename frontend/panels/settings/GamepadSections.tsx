/** Settings → Shortcuts & Controls, second half: enable gamepad input, pick the primary controller, test it. */
import type { ReactNode } from 'react'
import { Badge, Button, Callout, SettingsRow, SettingsSection, Switch } from '@kit'
import { useGamepad, getButtonName } from '../../bridge/useGamepad'
import { useSetting } from '../../bridge/useSetting'
import { GamepadButtonCapture } from '../../components/GamepadButtonCapture'
import { DEFAULT_CONTROLLER_BUTTONS, type ControllerButtons } from '@ui/settings'

/** The controller menu's command buttons, in the order the rows show them. */
const MENU_BUTTONS: { key: keyof ControllerButtons; label: string; description: string }[] = [
  {
    key: 'confirm',
    label: 'Select',
    description: 'Choose a menu item, or look the word up again.'
  },
  {
    key: 'back',
    label: 'Back',
    description: 'Close the menu, or leave the dictionary for the game.'
  },
  {
    key: 'backAlt',
    label: 'Back (second button)',
    description: 'Another button that does the same.'
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
  }
]

export function GamepadSections(): ReactNode {
  const {
    state: gamepadState,
    settings: gamepadSettings,
    setEnabled: setGamepadEnabled,
    setPreferredGamepad,
    source: gamepadSource
  } = useGamepad()

  const [menuButtons, setMenuButtons] = useSetting<ControllerButtons>(
    'controllerButtons',
    DEFAULT_CONTROLLER_BUTTONS
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

      {enabled && (
        <SettingsSection
          title="Controller menu"
          description="Buttons used while the controller menu or the dictionary is open. The D-pad and left stick move between items and words; the right stick scrolls the dictionary pop-up."
        >
          {MENU_BUTTONS.map(({ key, label, description }) => (
            <SettingsRow key={key} label={label} description={description}>
              <GamepadButtonCapture
                value={menuButtons[key] ?? undefined}
                onChange={(button) =>
                  void setMenuButtons({ ...menuButtons, [key]: button ?? null })
                }
                size="1"
              />
            </SettingsRow>
          ))}
        </SettingsSection>
      )}

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

/**
 * Settings → Shortcuts & Controls, second half: enable gamepad input, scan after a game button,
 * the buttons Game Mode uses (the controller menu and Read along), pick the primary controller,
 * test it.
 */
import type { ReactNode } from 'react'
import { Badge, Button, Callout, Select, SettingsRow, SettingsSection, Switch } from '@kit'
import type { AutoScanSettings } from '../../vendor/shared-types'
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
          'Choose a menu item. On a word, move into the dictionary pop-up to use its buttons; there, press the chosen button. In the full-screen dictionary, add the entry to Anki.'
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
        description: 'Jump up the dictionary pop-up to the definition before, or to the entry before in the full-screen dictionary.'
      },
      {
        key: 'nextDefinition',
        label: 'Next definition',
        description: 'Jump down the dictionary pop-up to the next definition, or to the next entry in the full-screen dictionary.'
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

const SCAN_DELAYS = [
  { value: '100', label: '100 ms' },
  { value: '500', label: '500 ms' },
  { value: '1000', label: '1 s' },
  { value: '1500', label: '1.5 s' },
  { value: '2000', label: '2 s' },
  { value: '3000', label: '3 s' }
]

/**
 * `autoScanSettings`: a button the game uses (the one that advances its text) also starts a scan,
 * after a delay for the next line to appear. The button keeps working in the game; native watches
 * it (`gamepad.rs`), and the switch gates it. Choosing a button turns it on.
 */
function ScanAfterButtonSection(): ReactNode {
  const [settings, setSettings] = useSetting<AutoScanSettings>('autoScanSettings', {
    enabled: false,
    scanDelay: 500
  })
  const update = (patch: Partial<AutoScanSettings>): void => void setSettings({ ...settings, ...patch })

  return (
    <SettingsSection
      title="Scan after a button press"
      description="Automatically scan after you press a button on your gamepad."
    >
      <SettingsRow
        label="Button"
        controlId="autoscan-enabled"
        description="Choose the button that triggers a scan."
      >
        <GamepadButtonCapture
          value={settings.gamepadButton}
          onChange={(button) =>
            update(button === undefined ? { gamepadButton: undefined, enabled: false } : { gamepadButton: button, enabled: true })
          }
          size="1"
        />
        <Switch
          id="autoscan-enabled"
          aria-label="Scan after a button press"
          checked={settings.enabled && settings.gamepadButton !== undefined}
          disabled={settings.gamepadButton === undefined}
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </SettingsRow>
      <SettingsRow label="Delay" description="How long to wait before scanning.">
        <Select
          aria-label="Scan delay"
          value={settings.scanDelay.toString()}
          onValueChange={(delay) => update({ scanDelay: parseInt(delay, 10) })}
          options={SCAN_DELAYS}
        />
      </SettingsRow>
    </SettingsSection>
  )
}

/** The buttons Game Mode uses, by where they act; shown while gamepad input is on. */
function ControllerButtonSections(): ReactNode {
  const [storedButtons, setMenuButtons] = useSetting<ControllerButtons>(
    'controllerButtons',
    DEFAULT_CONTROLLER_BUTTONS
  )
  const menuButtons = effectiveControllerButtons(storedButtons)
  const customised = (Object.keys(DEFAULT_CONTROLLER_BUTTONS) as (keyof ControllerButtons)[]).some(
    (key) => menuButtons[key] !== DEFAULT_CONTROLLER_BUTTONS[key]
  )

  return (
    <>
      {BUTTON_GROUPS.map((group, index) => (
        <SettingsSection
          key={group.title}
          title={group.title}
          description={group.description}
          actions={
            index === 0 && customised ? (
              <Button size="sm" onClick={() => void setMenuButtons({ ...DEFAULT_CONTROLLER_BUTTONS })}>
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
                badge={shared.length > 0 ? <Badge tone="warn">Same as {shared.join(', ')}</Badge> : undefined}
              >
                <GamepadButtonCapture
                  value={menuButtons[key] ?? undefined}
                  onChange={(button) => void setMenuButtons({ ...menuButtons, [key]: button ?? null })}
                  size="1"
                />
              </SettingsRow>
            )
          })}
        </SettingsSection>
      ))}
    </>
  )
}

export function GamepadSections(): ReactNode {
  const {
    state: gamepadState,
    settings: gamepadSettings,
    setEnabled: setGamepadEnabled,
    setPreferredGamepad,
    source: gamepadSource
  } = useGamepad()

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
            <Callout tone="warn">No gamepad has been detected.</Callout>
          </div>
        )}
      </SettingsSection>

      {/* Shown with gamepad support off too (the buttons disabled), so the bindings stay visible. */}
      <ScanAfterButtonSection />

      <ControllerButtonSections />

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

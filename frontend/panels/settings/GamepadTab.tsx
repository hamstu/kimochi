/** Settings → Gamepad: enable gamepad input, pick the primary controller and test its buttons. */
import type { ReactNode } from 'react'
import { Badge, Button, Callout, SettingsPage, SettingsRow, SettingsSection, Switch } from '@kit'
import { useGamepad, getButtonName } from '../../bridge/useGamepad'

export function GamepadTab(): ReactNode {
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
    <SettingsPage title="Gamepad" description="Trigger shortcuts and scans from a game controller.">
      <SettingsSection>
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
    </SettingsPage>
  )
}

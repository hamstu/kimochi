/** Settings → Translation & AI: translation (your DeepL key or Kimochi cloud) and the Explain action for Log lines. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Input, Select, SettingsPage, SettingsRow, SettingsSection } from '@kit'
import { ExplainSettingsModal } from '@texthooker/components/ExplainSettingsModal'
import { updateSettings } from '@texthooker/lib/settings'
import type { Settings, TranslationProvider } from '@texthooker/lib/types'
import { translationRoute } from '@ui/account'
import { useAccount } from '../../bridge/account'
import { openSettings } from '../../bridge/tauri'
import { WithReaderSettings } from './ReaderSettingsProvider'

export function AssistTab(): ReactNode {
  return (
    <SettingsPage
      title="Translation & AI"
      description="Help with a line you can't read yet. Both are in each line's menu in the Log."
    >
      <WithReaderSettings>{(settings) => <AssistSections settings={settings} />}</WithReaderSettings>
    </SettingsPage>
  )
}

/** The two choices. A stored `'auto'` (never chosen) shows as what it does now: `shownProvider`. */
const PROVIDERS: { value: Exclude<TranslationProvider, 'auto'>; label: string }[] = [
  { value: 'kimochi', label: 'Kimochi cloud' },
  { value: 'deepl', label: 'Your DeepL key' }
]

/** `'auto'` is Kimochi cloud with Kimochi Cloud and your DeepL key otherwise (`translationRoute`). */
function shownProvider(provider: TranslationProvider | undefined, cloud: boolean): 'kimochi' | 'deepl' {
  if (provider === 'kimochi' || provider === 'deepl') return provider
  return cloud ? 'kimochi' : 'deepl'
}

function providerDescription(settings: Settings, cloud: boolean): string {
  if (shownProvider(settings.translationProvider, cloud) === 'kimochi') {
    return cloud
      ? 'Uses your Kimochi Cloud monthly translations.'
      : 'Needs Kimochi Cloud: see Settings → Account.'
  }
  return translationRoute('deepl', settings.deeplApiKey, cloud)
    ? 'Choose the translation provider'
    : 'Add your DeepL API key below.'
}

function AssistSections({ settings }: { settings: Settings }): ReactNode {
  const { cloud } = useAccount()
  const [deeplDraft, setDeeplDraft] = useState(settings.deeplApiKey)
  const [explainOpen, setExplainOpen] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the draft follows outside changes
  useEffect(() => setDeeplDraft(settings.deeplApiKey), [settings.deeplApiKey])
  const provider = shownProvider(settings.translationProvider, cloud)

  const explainSummary =
    settings.explainProvider === 'kimochi'
      ? cloud
        ? 'Kimochi cloud'
        : 'Kimochi cloud (needs Kimochi Cloud, see Settings → Account)'
      : settings.explainProvider === 'claude'
        ? `Claude CLI · ${settings.explainClaudeModel}`
        : `Codex CLI${settings.explainCodexModel ? ` · ${settings.explainCodexModel}` : ''}`

  return (
    <div className="texthooker">
      <SettingsSection title="Translation">
        <SettingsRow label="Translate with" description={providerDescription(settings, cloud)}>
          <Select
            aria-label="Translate with"
            value={provider}
            onValueChange={(value) =>
              void updateSettings({ translationProvider: value as TranslationProvider })
            }
            // Kimochi cloud is offered with Kimochi Cloud; still listed while it is the choice.
            options={PROVIDERS.filter((p) => p.value !== 'kimochi' || cloud || provider === 'kimochi')}
          />
          {provider === 'kimochi' && !cloud && (
            <Button size="sm" onClick={() => void openSettings('account')}>
              Account…
            </Button>
          )}
        </SettingsRow>
        {provider !== 'kimochi' && (
          <SettingsRow
            label="DeepL API key"
            controlId="assist-deepl"
            description={
              settings.deeplApiKey.trim()
                ? 'Enter your DeepL key'
                : 'Stored locally in settings.json, never bundled or backed up.'
            }
          >
            <Input
              id="assist-deepl"
              type="password"
              mono
              autoComplete="off"
              className="settings-field"
              value={deeplDraft}
              onChange={(e) => setDeeplDraft(e.target.value)}
              onBlur={() => {
                const next = deeplDraft.trim()
                if (next !== settings.deeplApiKey) void updateSettings({ deeplApiKey: next })
              }}
              placeholder="xxxxxxxx-…-xxxxxxxx:fx"
            />
          </SettingsRow>
        )}
      </SettingsSection>

      <SettingsSection title="Explain with AI">
        <SettingsRow
          label="Provider, model and prompt"
          description={`${explainSummary}. Explain is in each line’s menu and on the E key.`}
        >
          <Button size="sm" onClick={() => setExplainOpen(true)}>
            Configure…
          </Button>
        </SettingsRow>
      </SettingsSection>
      <ExplainSettingsModal open={explainOpen} onOpenChange={setExplainOpen} settings={settings} />
    </div>
  )
}

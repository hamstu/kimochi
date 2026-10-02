/** Settings → Translation & AI: DeepL translation and the LLM Explain action for Log lines. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button, Input, SettingsPage, SettingsRow, SettingsSection } from '@kit'
import { ExplainSettingsModal } from '@texthooker/components/ExplainSettingsModal'
import { updateSettings } from '@texthooker/lib/settings'
import type { Settings } from '@texthooker/lib/types'
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

function AssistSections({ settings }: { settings: Settings }): ReactNode {
  const [deeplDraft, setDeeplDraft] = useState(settings.deeplApiKey)
  const [explainOpen, setExplainOpen] = useState(false)
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the draft follows outside changes
  useEffect(() => setDeeplDraft(settings.deeplApiKey), [settings.deeplApiKey])

  const explainSummary =
    settings.explainProvider === 'claude'
      ? `Claude CLI · ${settings.explainClaudeModel}`
      : `Codex CLI${settings.explainCodexModel ? ` · ${settings.explainCodexModel}` : ''}`

  return (
    <div className="texthooker">
      <SettingsSection title="Translation">
        <SettingsRow
          label="DeepL API key"
          controlId="assist-deepl"
          description={
            settings.deeplApiKey.trim()
              ? 'Key set. Translate is in each line’s menu and on the T key.'
              : 'Required for Translate. Stored locally in settings.json, never bundled.'
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
      </SettingsSection>

      <SettingsSection title="Explain">
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

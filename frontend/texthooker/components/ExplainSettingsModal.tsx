/* eslint react-hooks/set-state-in-effect: "off" -- Adapted editor drafts synchronize to session/setting changes and reset when dialogs close. */
import { useEffect, useState } from 'react'
import { Button, Dialog, DialogContent, Input, Select, SettingsRow, Textarea } from '@kit'
import { updateSettings } from '@texthooker/lib/settings'
import { defaultExplainPrompt, explainTemplate, isDefaultExplainPrompt } from '@ui/explain-prompt'
import type { ExplainProvider, Settings } from '@texthooker/lib/types'
import { DEFAULT_FOCUS_PROMPT } from '@ui/explain-screen'
import {
  EXPLAIN_EFFORTS,
  OPENAI_DEFAULT_MODEL,
  OPENAI_MODELS,
  ULTRAFAST_MODELS,
  listedOpenaiModel,
  explainPrice,
  openaiTiers,
  explainSettings,
  priceText
} from '@ui/explain-settings'
import { useAccount } from '../../bridge/account'
import { useLanguage } from '../../bridge/useLanguage'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: Settings
}

/** The effort select's "the CLI's own" entry (a select option needs a value; stored as ''). */
const DEFAULT_EFFORT = 'default'

/** The OpenAI model select's "type one in" entry. */
const OTHER_MODEL = 'other'

/** Claude CLI model aliases. Opus is the default per project preference —
    deliberately not the newer Fable tier, though it stays selectable. */
const CLAUDE_MODELS = [
  { value: 'opus', label: 'Opus (default)' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'fable', label: 'Fable' }
]

export function ExplainSettingsModal({ open, onOpenChange, settings }: Props) {
  const { cloud } = useAccount()
  const [language] = useLanguage()
  // A default prompt is shown as the language's template; the user's own as written.
  const shown = explainTemplate(settings.explainPrompt, language.code)
  const fallback = defaultExplainPrompt(language.code)
  const [promptDraft, setPromptDraft] = useState(shown)
  // The instruction for a highlighted word: the default shown when none of the reader's own is kept.
  const focusShown = settings.explainFocusPrompt.trim() ? settings.explainFocusPrompt : DEFAULT_FOCUS_PROMPT
  const [focusDraft, setFocusDraft] = useState(focusShown)
  const [codexModelDraft, setCodexModelDraft] = useState(settings.explainCodexModel)
  const [openaiModelDraft, setOpenaiModelDraft] = useState(settings.explainOpenaiModel)
  // A model typed in rather than chosen from the list (shown with its field).
  const [otherModel, setOtherModel] = useState(!listedOpenaiModel(settings.explainOpenaiModel))
  const [openaiKeyDraft, setOpenaiKeyDraft] = useState(settings.openaiApiKey)

  useEffect(() => {
    if (open) {
      setPromptDraft(shown)
      setFocusDraft(focusShown)
      setCodexModelDraft(settings.explainCodexModel)
      setOpenaiModelDraft(settings.explainOpenaiModel)
      setOtherModel(!listedOpenaiModel(settings.explainOpenaiModel))
      setOpenaiKeyDraft(settings.openaiApiKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const provider = settings.explainProvider
  // OpenAI's model and tier as Explain will use them, for the price preview (the model as typed,
  // before it is saved, so the preview follows the field).
  const openaiChoice = explainSettings({ ...settings, explainOpenaiModel: openaiModelDraft })
  // Other… with no name typed yet has no model to price.
  const price = otherModel && !openaiModelDraft.trim() ? null : explainPrice(openaiChoice.model, openaiChoice.tier)
  // gpt-6-luna is the OpenAI model chosen (or the default), for which None is the effort to use.
  const lunaChosen = provider === 'openai' && (openaiChoice.model ?? OPENAI_DEFAULT_MODEL) === OPENAI_DEFAULT_MODEL
  // The effort each provider keeps, and what "default" means for it.
  const effortSetting =
    provider === 'claude'
      ? { value: settings.explainClaudeEffort, key: 'explainClaudeEffort', label: 'CLI default' }
      : provider === 'codex'
        ? { value: settings.explainCodexEffort, key: 'explainCodexEffort', label: 'CLI default (config.toml)' }
        : { value: settings.explainOpenaiEffort, key: 'explainOpenaiEffort', label: "The model's default" }

  const savePrompt = () => {
    const next = promptDraft.trim() ? promptDraft : fallback
    // A default stays as stored (it follows the language either way).
    if (isDefaultExplainPrompt(next) && isDefaultExplainPrompt(settings.explainPrompt)) return
    if (next !== settings.explainPrompt) {
      void updateSettings({ explainPrompt: next })
    }
  }

  const saveFocus = () => {
    // The default (or nothing) is stored as empty, so it keeps following the default.
    const next = !focusDraft.trim() || focusDraft === DEFAULT_FOCUS_PROMPT ? '' : focusDraft
    if (!focusDraft.trim()) setFocusDraft(DEFAULT_FOCUS_PROMPT)
    if (next !== settings.explainFocusPrompt) void updateSettings({ explainFocusPrompt: next })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="lg"
        title="Explain settings"
        description="The model that explains a line, how hard it thinks, and the prompt it gets."
      >
        <div className="explain-settings">
          <div className="k-settings-group">
            <SettingsRow label="Provider">
              <Select
                aria-label="Provider"
                value={settings.explainProvider}
                onValueChange={(v) => void updateSettings({ explainProvider: v as ExplainProvider })}
                // Kimochi cloud needs Kimochi Cloud; still listed while it is the choice.
                options={[
                  { value: 'kimochi', label: 'Kimochi cloud' },
                  { value: 'openai', label: 'OpenAI API (your key)' },
                  { value: 'codex', label: 'Codex CLI' },
                  { value: 'claude', label: 'Claude CLI' }
                ].filter((o) => o.value !== 'kimochi' || cloud || settings.explainProvider === 'kimochi')}
              />
            </SettingsRow>
            {settings.explainProvider === 'kimochi' ? (
              <SettingsRow
                label="Kimochi cloud"
                description={
                  cloud
                    ? "Runs on Kimochi's server within your Kimochi Cloud monthly explanations."
                    : 'Needs Kimochi Cloud: see Settings → Account.'
                }
              />
            ) : provider === 'openai' ? (
              <>
                <SettingsRow
                  label="OpenAI API key"
                  controlId="explain-openai-key"
                  description="Billed to this key per explanation. Stored in settings.json on this computer only, never synced."
                >
                  <Input
                    id="explain-openai-key"
                    type="password"
                    mono
                    autoComplete="off"
                    className="settings-field"
                    value={openaiKeyDraft}
                    onChange={(e) => setOpenaiKeyDraft(e.target.value)}
                    onBlur={() => {
                      const next = openaiKeyDraft.trim()
                      if (next !== settings.openaiApiKey) void updateSettings({ openaiApiKey: next })
                    }}
                    placeholder="sk-…"
                  />
                </SettingsRow>
                <SettingsRow label="OpenAI model" description="gpt-6-luna is recommended for minimal latency.">
                  <Select
                    aria-label="OpenAI model"
                    value={otherModel ? OTHER_MODEL : openaiModelDraft.trim() || OPENAI_DEFAULT_MODEL}
                    onValueChange={(v) => {
                      if (v === OTHER_MODEL) {
                        // Typed in below, starting from the model in use: it stays the model (and
                        // the one priced) until another name is typed.
                        setOtherModel(true)
                        setOpenaiModelDraft(settings.explainOpenaiModel)
                        return
                      }
                      setOtherModel(false)
                      setOpenaiModelDraft(v)
                      if (v !== settings.explainOpenaiModel) void updateSettings({ explainOpenaiModel: v })
                    }}
                    options={[...OPENAI_MODELS, { value: OTHER_MODEL, label: 'Other…' }]}
                  />
                </SettingsRow>
                {otherModel && (
                  <SettingsRow
                    label="Model name"
                    controlId="explain-openai-model"
                    description="Any chat model your key can use, as OpenAI names it."
                  >
                    <Input
                      id="explain-openai-model"
                      mono
                      autoFocus
                      className="settings-field"
                      value={openaiModelDraft}
                      onChange={(e) => setOpenaiModelDraft(e.target.value)}
                      onBlur={() => {
                        const next = openaiModelDraft.trim()
                        if (next && next !== settings.explainOpenaiModel) {
                          void updateSettings({ explainOpenaiModel: next })
                        }
                      }}
                      placeholder="gpt-…"
                    />
                  </SettingsRow>
                )}
              </>
            ) : settings.explainProvider === 'claude' ? (
              <SettingsRow label="Claude model">
                <Select
                  aria-label="Claude model"
                  value={settings.explainClaudeModel}
                  onValueChange={(v) => void updateSettings({ explainClaudeModel: v })}
                  options={CLAUDE_MODELS}
                />
              </SettingsRow>
            ) : (
              <SettingsRow label="Codex model" controlId="explain-codex-model">
                <Input
                  id="explain-codex-model"
                  mono
                  className="settings-field"
                  value={codexModelDraft}
                  onChange={(e) => setCodexModelDraft(e.target.value)}
                  onBlur={() => {
                    const next = codexModelDraft.trim()
                    if (next !== settings.explainCodexModel) {
                      void updateSettings({ explainCodexModel: next })
                    }
                  }}
                  placeholder="(CLI default)"
                />
              </SettingsRow>
            )}
            {provider !== 'kimochi' && (
              <SettingsRow
                label="Effort"
                description={
                  provider === 'openai'
                    ? "How long a reasoning model thinks before it answers. None skips thinking and starts soonest. Not every model takes every effort: if OpenAI refuses one, choose another or the model's default."
                    : provider === 'codex'
                      ? "How long the model thinks before it answers. Lower starts the answer sooner; higher can explain harder lines better. Not every model takes every effort: if Codex refuses one, choose another or the CLI's default."
                      : 'How long the model thinks before it answers. Lower starts the answer sooner; higher can explain harder lines better.'
                }
              >
                <Select
                  aria-label="Effort"
                  value={effortSetting.value || DEFAULT_EFFORT}
                  onValueChange={(v) =>
                    void updateSettings({ [effortSetting.key]: v === DEFAULT_EFFORT ? '' : v } as Partial<Settings>)
                  }
                  options={[
                    { value: DEFAULT_EFFORT, label: effortSetting.label },
                    // None with gpt-6-luna: it starts writing in about a second, after 5–6 s of thinking otherwise.
                    ...EXPLAIN_EFFORTS[provider].map((effort) =>
                      lunaChosen && effort.value === 'none' ? { ...effort, label: 'None (recommended)' } : effort
                    )
                  ]}
                />
              </SettingsRow>
            )}
            {provider === 'openai' && (
              <SettingsRow
                label="Service tier"
                description={
                  ULTRAFAST_MODELS.includes(openaiChoice.model ?? OPENAI_DEFAULT_MODEL)
                    ? 'Fast answers in about half the time of Normal, for twice the price. Ultrafast is quicker still, for six times the price.'
                    : 'Fast answers in about half the time of Normal, for twice the price.'
                }
              >
                <Select
                  aria-label="Service tier"
                  value={openaiChoice.tier ?? 'fast'}
                  onValueChange={(v) => void updateSettings({ explainOpenaiTier: v })}
                  options={[...openaiTiers(openaiChoice.model)]}
                />
              </SettingsRow>
            )}
          </div>

          <div className="explain-prompt-head">
            <label className="k-settings-row-label" htmlFor="explain-prompt">
              Prompt
            </label>
            {provider === 'openai' && (
              // What a typical line with its scene costs with the model and tier chosen: the prompt
              // is most of what is paid for.
              <span className="explain-prompt-price">
                {price === null ? 'No price estimate for this model' : priceText(price)}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPromptDraft(fallback)}
              disabled={promptDraft === fallback}
            >
              Reset to default
            </Button>
          </div>
          <Textarea
            id="explain-prompt"
            mono
            className="explain-prompt"
            value={promptDraft}
            onChange={(e) => setPromptDraft(e.target.value)}
            onBlur={savePrompt}
            spellCheck={false}
          />
          {language.code !== 'ja' && !isDefaultExplainPrompt(promptDraft) && (
            <p className="k-description">
              Your prompt was written for Japanese, or is your own: it is sent as written. Reset to default for the
              prompt that follows the language you&apos;re learning ({language.name}).
            </p>
          )}
          <p className="k-description">
            <span className="k-mono">{'{{language}}'}</span> is replaced with the language you&apos;re learning (
            {language.name}), <span className="k-mono">{'{{context}}'}</span> with the previous lines and{' '}
            <span className="k-mono">{'{{sentence}}'}</span> with the line being explained. Cached explanations keep
            their old text; use Regenerate in the Explain dialog after editing.
          </p>

          <div className="explain-prompt-head">
            <label className="k-settings-row-label" htmlFor="explain-focus-prompt">
              Prompt for a highlighted word
            </label>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setFocusDraft(DEFAULT_FOCUS_PROMPT)}
              disabled={focusDraft === DEFAULT_FOCUS_PROMPT}
            >
              Reset to default
            </Button>
          </div>
          <Textarea
            id="explain-focus-prompt"
            mono
            className="explain-focus-prompt"
            value={focusDraft}
            onChange={(e) => setFocusDraft(e.target.value)}
            onBlur={saveFocus}
            spellCheck={false}
          />
          <p className="k-description">
            Added after the prompt when you explain over your game while pointing at a word (Alt+X).{' '}
            <span className="k-mono">{'{{word}}'}</span> is replaced with that word. Where the word is found in the
            sentence, it is marked there as <span className="k-mono">{'<TO EXPLAIN>…</TO EXPLAIN>'}</span>.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

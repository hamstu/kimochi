/**
 * Settings → Language: the language being learned (the `language` setting), what does not work
 * in it yet when it is not Japanese, a few notes from its traits in `ui/languages.ts`, and which
 * of this computer's OCR engines can read it (their `languages` capability).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Badge, Button, Callout, SettingsPage, SettingsRow, SettingsSection } from '@kit'
import { engineReadsLanguage } from '@ui/capabilities'
import { engineHint, engineOffered } from '@ui/ocr-engines'
import { OCR_MODES, ocrModeInfo, type OcrMode } from '../../bridge/settings'
import { useCapabilities } from '../../bridge/capabilities'
import { useLanguage } from '../../bridge/useLanguage'
import { useSetting } from '../../bridge/useSetting'
import { OcrEngineIcon } from '../../components/EngineIcon'
import { ExperimentalLanguageNote } from '../../components/ExperimentalLanguageNote'
import { LanguagePicker } from '../../components/LanguagePicker'
import { engineSwitchNote, languageNotes } from './languageNotes'
import { DictionaryProfileSection } from './DictionaryProfileSection'
import { showSettingsTab } from './showSettingsTab'
import './language-tab.css'

const MODES = Object.keys(OCR_MODES) as OcrMode[]

/** How long after choosing a language an engine change is taken as the one it caused. */
const SWITCH_WINDOW_MS = 5000

const names = (modes: readonly OcrMode[]): string => modes.map((mode) => ocrModeInfo(mode).name).join(', ')

export function LanguageTab(): ReactNode {
  const [language, setLanguage] = useLanguage()
  const [ocrMode] = useSetting<OcrMode>('ocrMode', 'googlelens')
  const capabilities = useCapabilities()
  const engines = capabilities.ocrEngines
  // This computer's engines (Kimochi cloud only with an account), split by whether they read it.
  const offered = MODES.filter(
    (mode) => engineOffered(mode, capabilities.os) && (mode !== 'cloud' || capabilities.cloudAccess)
  )
  const readers = offered.filter((mode) => engineReadsLanguage(engines[mode], language.code))
  const others = offered.filter((mode) => !readers.includes(mode))
  const currentReads = engineReadsLanguage(engines[ocrMode], language.code)

  // The engine Kimochi switched to because the language changed (native `follow_language` writes
  // `ocrMode` just after `language`): said once, for that change, until the engine changes again
  // or the page is left.
  const asked = useRef<{ from: OcrMode; code: string; at: number } | null>(null)
  const [switched, setSwitched] = useState<{ from: OcrMode; to: OcrMode; code: string } | null>(null)
  useEffect(() => {
    const pending = asked.current
    if (pending && pending.from !== ocrMode && Date.now() - pending.at < SWITCH_WINDOW_MS) {
      asked.current = null
      setSwitched({ from: pending.from, to: ocrMode, code: pending.code })
    } else {
      setSwitched((shown) => (shown && shown.to !== ocrMode ? null : shown))
    }
  }, [ocrMode])
  const switchNote =
    switched && switched.to === ocrMode && switched.code === language.code
      ? engineSwitchNote(
          ocrModeInfo(switched.from).name,
          ocrModeInfo(switched.to).name,
          language.name,
          engineReadsLanguage(engines[switched.from], language.code)
        )
      : null

  return (
    <SettingsPage title="Language" description="Choose the language you're learning and scanning with Kimochi.">
      <SettingsSection>
        <SettingsRow label="Language" description="Kimochi reads and looks up text in this language.">
          <LanguagePicker
            value={language.code}
            onValueChange={(code) => {
              if (code === language.code) return
              asked.current = { from: ocrMode, code, at: Date.now() }
              setSwitched(null)
              void setLanguage(code).catch((error: unknown) => console.error('Saving the language failed:', error))
            }}
          />
        </SettingsRow>
      </SettingsSection>

      <ExperimentalLanguageNote language={language} />

      <SettingsSection title={`About ${language.name}`} grouped={false}>
        <ul className="language-notes">
          {languageNotes(language).map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </SettingsSection>

      {!currentReads && (
        <Callout tone="warn">
          {ocrModeInfo(ocrMode).name}, the OCR engine in use, can&apos;t read {language.name}.
          <Button size="sm" onClick={() => showSettingsTab('ocr')}>
            Choose another engine
          </Button>
        </Callout>
      )}

      <SettingsSection
        title="Supported OCR engines"
        description={
          switchNote
            ? `These are the engines that work with ${language.name}. ${switchNote}`
            : `These are the engines that work with ${language.name}.`
        }
        footnote={others.length > 0 ? `Can't read ${language.name}: ${names(others)}.` : undefined}
      >
        {readers.map((mode) => {
          const hint = engineHint(engines[mode], null)
          return (
            <SettingsRow
              key={mode}
              label={
                <span className="language-engine">
                  <OcrEngineIcon mode={mode} />
                  {ocrModeInfo(mode).name}
                </span>
              }
            >
              {mode === ocrMode ? (
                <Badge tone="accent">In use</Badge>
              ) : (
                hint && (
                  <span className="language-engine-hint" title={hint.reason}>
                    {hint.text}
                  </span>
                )
              )}
            </SettingsRow>
          )
        })}
      </SettingsSection>

      <DictionaryProfileSection readOnly />
    </SettingsPage>
  )
}

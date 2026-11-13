/**
 * A heads-up that Kimochi was made for Japanese, said where the language is chosen (Settings →
 * Language and the welcome guide's language step) when another language is. Its "reach out for
 * support" opens Help, the same dialog as the title bar's ? button. Nothing for Japanese.
 */
import { useState, type ReactNode } from 'react'
import { Callout } from '@kit'
import { isJapanese, type Language } from '@ui/languages'
import { inDemo } from '../bridge/demo'
import { HelpDialog } from '../main/HelpDialog'
import './experimental-language-note.css'

export function ExperimentalLanguageNote({ language }: { language: Language }): ReactNode {
  const [help, setHelp] = useState(false)
  if (isJapanese(language.code)) return null
  return (
    <Callout>
      <span>
        <strong>Heads up:</strong> Kimochi was originally made for Japanese, so not everything works
        perfectly in other languages, and some features might be missing. If you have any issues,{' '}
        {inDemo() ? (
          'reach out for support'
        ) : (
          <button type="button" className="language-note-link" onClick={() => setHelp(true)}>
            reach out for support
          </button>
        )}
        .
      </span>
      {!inDemo() && <HelpDialog open={help} onOpenChange={setHelp} />}
    </Callout>
  )
}

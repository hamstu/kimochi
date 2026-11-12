/**
 * What does not work yet in a language other than Japanese, said where the language is chosen
 * (Settings → Language and the welcome guide's language step). Nothing for Japanese.
 */
import type { ReactNode } from 'react'
import { FlaskConical } from 'lucide-react'
import { Callout } from '@kit'
import { isJapanese, type Language } from '@ui/languages'

export function ExperimentalLanguageNote({ language }: { language: Language }): ReactNode {
  if (isJapanese(language.code)) return null
  return (
    <Callout tone="warn" icon={<FlaskConical />}>
      <span>
        <strong>Support for {language.name} is experimental.</strong> Kimochi was made for Japanese,
        and some of it doesn&apos;t work in other languages yet: read-aloud voices, word audio, and
        the furigana and pitch-accent card fields. The Hachidori and 10ten dictionaries read
        Japanese only, and right-to-left languages aren&apos;t offered yet.
      </span>
    </Callout>
  )
}

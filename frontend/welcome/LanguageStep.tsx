/**
 * The question straight after the intro (in Gaming Mode too): which language the reader is
 * learning. The list is shown in place, to scroll and tap or to search; the stored language is
 * chosen already (Japanese on a new install). A choice is saved at once, since the OCR and
 * dictionary steps after this one are drawn for it.
 */
import type { JSX } from 'react'
import { Link } from 'react-router'
import { Button } from '@kit'
import { useLanguage } from '../bridge/useLanguage'
import { LanguagePicker } from '../components/LanguagePicker'
import { ExperimentalLanguageNote } from '../components/ExperimentalLanguageNote'
import Step from './Step'
import { StepActions } from './StepActions'
import style from './WelcomeApp.module.css'

export default function LanguageStep({ next }: { next: string }): JSX.Element {
  const [language, setLanguage] = useLanguage()
  return (
    <Step
      title="What language are you learning?"
      lede="Kimochi reads text in this language. You can change it later in Settings → Language."
    >
      <LanguagePicker
        inline
        className={style.languagePicker}
        value={language.code}
        onValueChange={(code) => void setLanguage(code).catch((error: unknown) => console.error('Saving the language failed:', error))}
      />
      <ExperimentalLanguageNote language={language} />
      <StepActions>
        <Button variant="primary" asChild>
          <Link to={next}>Continue</Link>
        </Button>
      </StepActions>
    </Step>
  )
}

/**
 * Which Built-in Yomitan profile the account in use looks words up through (ui/yomitan-profiles.ts):
 * Settings → Account lets it be chosen; Settings → Language shows it (`readOnly`), with the way
 * to Account. Shown only while Built-in Yomitan is the engine in use. The profiles are Yomitan's,
 * made and edited in its own settings, which the button opens at its Profile section.
 */
import { useState, type ReactNode } from 'react'
import { Button, Callout, Select, SettingsRow, SettingsSection } from '@kit'
import { accountSlot } from '@ui/yomitan-profiles'
import { nativeError } from '../../bridge/tauri'
import { useAccount } from '../../bridge/account'
import { openDictionarySettingsSection, useDictionaryEngine } from '../../bridge/dictionaryEngine'
import { useLanguage } from '../../bridge/useLanguage'
import {
  chooseYomitanProfile,
  profileLanguageName,
  profileReads,
  useProfileLinks,
  useYomitanProfiles
} from '../../bridge/yomitanProfiles'
import { showSettingsTab } from './showSettingsTab'

export function DictionaryProfileSection({ readOnly = false }: { readOnly?: boolean }): ReactNode {
  const [engine] = useDictionaryEngine()
  const account = useAccount()
  const [language] = useLanguage()
  const published = useYomitanProfiles()
  const links = useProfileLinks()
  const [error, setError] = useState<string | null>(null)
  if (engine !== 'yomitan') return null

  const key = account.profile?.key ?? null
  // Published for this account (an older report, from before a switch, is not shown as its).
  const profiles = published && published.account === accountSlot(key) ? published : null
  const inUse = profiles?.profiles[profiles.current] ?? null
  const mismatch = inUse && !profileReads(inUse.language, language.code)

  const choose = (name: string): void => {
    setError(null)
    chooseYomitanProfile(links, key, name, language.code).catch((caught: unknown) =>
      setError(`Could not change the profile: ${nativeError(caught).message}`)
    )
  }
  const manage = (): void => {
    openDictionarySettingsSection('profile').catch((caught: unknown) =>
      setError(`Could not open Yomitan’s settings: ${nativeError(caught).message}`)
    )
  }

  if (readOnly) {
    return (
      <SettingsSection title="Dictionary profile">
        <SettingsRow
          label={inUse ? `Yomitan profile: ${inUse.name} (${profileLanguageName(inUse.language)})` : 'Yomitan profile'}
          description="Each account looks words up with its own Yomitan profile. Choose it in Settings → Account."
        >
          <Button size="sm" onClick={() => showSettingsTab('account')}>
            Account settings
          </Button>
        </SettingsRow>
      </SettingsSection>
    )
  }

  return (
    <SettingsSection
      title="Dictionary profile"
      description="Dictionaries are shared by every account on this computer. Each account uses its own Yomitan profile, which keeps its language and dictionary choices apart."
    >
      <SettingsRow
        label="Yomitan profile"
        controlId="yomitan-profile"
        description={
          profiles ? 'Kimochi switches to it whenever you switch to this account.' : 'Shown once Yomitan has started.'
        }
      >
        <Select
          aria-label="Yomitan profile"
          value={inUse?.name}
          disabled={!profiles}
          placeholder="Not started"
          onValueChange={choose}
          options={(profiles?.profiles ?? []).map((profile) => ({
            value: profile.name,
            label: profile.name,
            detail: profileLanguageName(profile.language)
          }))}
        />
      </SettingsRow>
      <SettingsRow label="Profiles" description="Add, rename or remove profiles in Yomitan’s settings.">
        <Button size="sm" onClick={manage}>
          Manage profiles
        </Button>
      </SettingsRow>
      {mismatch && inUse && (
        <div className="settings-note">
          <Callout tone="warn">
            {inUse.name} looks words up in {profileLanguageName(inUse.language)}, and you’re learning {language.name}.
            Choose another profile, or change its language in Yomitan’s settings.
          </Callout>
        </div>
      )}
      {error && (
        <div className="settings-note">
          <Callout tone="danger">{error}</Callout>
        </div>
      )}
    </SettingsSection>
  )
}

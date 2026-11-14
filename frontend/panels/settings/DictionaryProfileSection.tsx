/**
 * Which Built-in Yomitan profile the account in use looks words up through (ui/yomitan-profiles.ts).
 * Settings → Account chooses it in a small inset under the active account's row
 * (`AccountDictionaryProfile`); Settings → Language shows it (`DictionaryProfileSection`), with the
 * way to Account. Both show only while Built-in Yomitan is the engine in use and is downloaded
 * on this computer (without it there are no profiles to choose). The profiles are
 * Yomitan's, made and edited in its own settings, which Manage opens at its Profile section.
 */
import { useState, type ReactNode } from 'react'
import { Button, Callout, Select, SettingsRow, SettingsSection } from '@kit'
import { accountSlot } from '@ui/yomitan-profiles'
import { nativeError } from '../../bridge/tauri'
import { DictionaryEngineIcon } from '../../components/EngineIcon'
import { useAccount } from '../../bridge/account'
import { useExtensionStatus } from '../../bridge/extensions'
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

/** The account in use's Yomitan profile, and choosing or managing it. */
function useAccountYomitanProfile() {
  const [engine] = useDictionaryEngine()
  const download = useExtensionStatus('yomitan')
  const account = useAccount()
  const [language] = useLanguage()
  const published = useYomitanProfiles()
  const links = useProfileLinks()
  const [error, setError] = useState<string | null>(null)

  const key = account.profile?.key ?? null
  // Published for this account (an older report, from before a switch, is not shown as its).
  const profiles = published && published.account === accountSlot(key) ? published : null
  const inUse = profiles?.profiles[profiles.current] ?? null
  const mismatch = inUse && !profileReads(inUse.language, language.code) ? inUse : null

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
  // Not downloaded (or not yet reported): nothing to choose from, so nothing is shown.
  const yomitan = engine === 'yomitan' && download?.state === 'ready'
  return { yomitan, language, profiles, inUse, mismatch, error, choose, manage }
}

/** Settings → Language: the profile in use, read-only, with the way to Settings → Account. */
export function DictionaryProfileSection(): ReactNode {
  const { yomitan, inUse } = useAccountYomitanProfile()
  if (!yomitan) return null
  return (
    <SettingsSection title="Dictionaries">
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

/**
 * Settings → Account: the active account's Yomitan profile, in an inset under its row. One line of
 * explanation, then the profile on one line with Manage beside it.
 */
export function AccountDictionaryProfile(): ReactNode {
  const { yomitan, language, profiles, inUse, mismatch, error, choose, manage } = useAccountYomitanProfile()
  if (!yomitan) return null
  return (
    <div className="account-inset">
      <div className="account-inset-box">
        <p className="account-inset-note">
          {profiles
            ? 'Lookups use this Yomitan profile while this account is in use.'
            : 'The Yomitan profile shows once Yomitan has started.'}
        </p>
        <div className="account-inset-line">
          <DictionaryEngineIcon engine="yomitan" className="account-inset-icon" />
          <span className="account-inset-label" id="account-yomitan-profile">
            Yomitan profile
          </span>
          <Select
            size="sm"
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
          <Button size="sm" variant="ghost" onClick={manage}>
            Manage
          </Button>
        </div>
        {mismatch && (
          <Callout tone="warn">
            {mismatch.name} looks words up in {profileLanguageName(mismatch.language)}, and you’re learning{' '}
            {language.name}. Choose another profile, or change its language in Yomitan’s settings.
          </Callout>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </div>
  )
}

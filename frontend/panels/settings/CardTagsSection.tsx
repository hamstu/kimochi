/**
 * Settings → Anki → Card enhancement → Tags: the tags every new card gets, whichever dictionary
 * made it (`cardTags`; src-tauri/src/card_tags.rs adds them). `{{session-name}}` is the open
 * session's name; the row under the field shows the tags a card made now would get.
 */
import { useSyncExternalStore, type ReactNode } from 'react'
import { Badge, SettingsRow, SettingsSection, Switch } from '@kit'
import { SETTINGS_DEFAULTS, type CardTagsSettings } from '@ui/settings'
import { getActiveSession, subscribeSessions } from '@texthooker/core/sessions'
import { useSetting } from '../../bridge/useSetting'
import { FieldInput } from './SentenceAudioSection'
import { cardTags } from './cardTags'

const DEFAULTS = SETTINGS_DEFAULTS.cardTags

function sessionName(): string | null {
  try {
    return getActiveSession().name.trim() || null
  } catch {
    // The sessions aren't loaded in this window (yet).
    return null
  }
}

export function CardTagsSection(): ReactNode {
  const [stored, save] = useSetting<CardTagsSettings>('cardTags', DEFAULTS)
  const config = { ...DEFAULTS, ...stored }
  const session = useSyncExternalStore(subscribeSessions, sessionName)
  const preview = cardTags(config.tags, session)

  return (
    <SettingsSection>
      <SettingsRow
        label="Add tags"
        controlId="card-tags-enabled"
        description="Kimochi tags every new card you make, with any dictionary."
      >
        <Switch
          id="card-tags-enabled"
          checked={config.enabled}
          onCheckedChange={(enabled) => void save({ ...config, enabled })}
        />
      </SettingsRow>
      {config.enabled && (
        <SettingsRow
          label="Tags"
          controlId="card-tags"
          description={
            <>
              Separate them with commas. <code>{'{{session-name}}'}</code> becomes the name of the
              session you&apos;re reading.
            </>
          }
          stacked
        >
          <div className="card-tags-control">
            <FieldInput
              id="card-tags"
              value={config.tags}
              placeholder="kimochi, {{session-name}}"
              optional
              onSave={(tags) => void save({ ...config, tags })}
            />
            <p className="card-tags-preview">
              {preview.length > 0 ? (
                <>
                  <span>A card made now gets</span>
                  {preview.map((tag) => (
                    <Badge key={tag}>{tag}</Badge>
                  ))}
                </>
              ) : (
                <span>No tags.</span>
              )}
            </p>
          </div>
        </SettingsRow>
      )}
    </SettingsSection>
  )
}

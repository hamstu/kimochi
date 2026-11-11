/**
 * Screen AI's part of the engine chooser's detail panel (`EngineSettings`): where the copy in use
 * comes from, or how to get one.
 *
 * Screen AI is Google's library, never bundled with Kimochi. A browser's copy (Chrome fetches it on
 * its own) is used as it is, and the panel says so. Without one, the usual model block offers
 * Google's package (`model_store`, engine `screenai`), and "Look again" checks for a browser's copy
 * that has arrived since, for someone who would rather let Chrome fetch it.
 */
import { useState, type ReactNode } from 'react'
import { Button, Callout } from '@kit'
import { screenAiSource } from '@ui/ocr-engines'
import { refreshCapabilities, useCapabilities } from '../../bridge/capabilities'
import { modelStatus, type ModelControls } from '../../bridge/models'
import { ModelDownload } from './ModelDownload'

export function ScreenAiSetup({
  model,
  emphasis
}: {
  model: ModelControls
  emphasis: boolean
}): ReactNode {
  const capability = useCapabilities().ocrEngines.screenai
  const [looking, setLooking] = useState(false)
  const lookAgain = (): void => {
    setLooking(true)
    void Promise.all([refreshCapabilities(), modelStatus('screenai').catch(() => null)]).finally(() =>
      setLooking(false)
    )
  }
  const from = capability?.available ? screenAiSource(capability.source) : null
  const version = capability?.version ? ` · version ${capability.version}` : ''
  const line =
    from && model.status?.state === 'ready'
      ? capability?.source === 'downloaded'
        ? `Ready · downloaded from Google${version}`
        : `Ready · using ${from}${version}`
      : undefined
  // Not only waiting for a download: a copy that would not start, or a missing helper.
  const problem = !capability?.available && !capability?.model ? capability?.reason : null
  return (
    <>
      {problem && <Callout tone="warn">{problem}</Callout>}
      <ModelDownload controls={model} emphasis={emphasis} label="Screen AI" line={line} />
      {!capability?.available && (
        <div className="engine-setting">
          <div className="engine-setting-text">
            <span className="k-description">
              Or let Google Chrome fetch it: open chrome://components in Chrome, find Screen AI and
              choose Check for update, then look again.
            </span>
          </div>
          <div className="engine-setting-control">
            <Button size="sm" disabled={looking} onClick={lookAgain}>
              {looking ? 'Looking…' : 'Look again'}
            </Button>
          </div>
        </div>
      )}
    </>
  )
}

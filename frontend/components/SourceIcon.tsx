import { useEffect, useState, type JSX } from 'react'
import { AppWindow } from 'lucide-react'
import type { CaptureSource } from '../vendor/shared-types'
import { sourceIcon } from '../bridge/tauri'
import styles from './SourceIcon.module.css'

/**
 * The selected window's app icon. The source catalog leaves icons out for speed, so it is fetched
 * (natively cached per app) when the source does not carry one. A soft placeholder holds the
 * slot and the icon fades in once decoded; an app without an icon keeps the generic glyph.
 */
export function SourceIcon({ source }: { source: CaptureSource }): JSX.Element {
  const app = source.appName || source.name
  const [fetched, setFetched] = useState<{
    app: string
    url: string | null
  } | null>(null)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const url = source.icon || (fetched?.app === app ? fetched.url : undefined)
  const settled = Boolean(source.icon) || fetched?.app === app

  useEffect(() => {
    if (source.icon || !app) return
    let live = true
    sourceIcon(app)
      .then((result) => live && setFetched({ app, url: result.icon }))
      .catch(() => live && setFetched({ app, url: null }))
    return () => {
      live = false
    }
  }, [app, source.icon])

  const loaded = Boolean(url) && loadedUrl === url

  if (settled && !url) return <AppWindow width="16" height="16" className={styles.glyph} />
  return (
    <span className={styles.icon} data-loaded={loaded || undefined} aria-hidden>
      {url && (
        <img
          src={url}
          alt=""
          draggable={false}
          onLoad={() => setLoadedUrl(url ?? null)}
          onError={() => setFetched({ app, url: null })}
        />
      )}
    </span>
  )
}

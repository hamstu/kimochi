/**
 * The browser extension's OCR model menu, kept the same as the sidebar's (src-tauri/src/
 * browser_bridge.rs): the engines listed here, with their pictures, names, taglines and where they
 * run, go to every connected tab whenever any of it changes, and a pick made in a tab is made
 * here, through the same selection (and the same download question) as the sidebar's.
 */
import { useEffect, useRef, type JSX } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { engineListed } from '@ui/ocr-engines'
import { OCR_MODES, ocrModeInfo, type OcrMode } from '../bridge/settings'
import { useCapabilities } from '../bridge/capabilities'
import { useEngineSelection } from '../bridge/useEngineSelection'
import { useLanguage } from '../bridge/useLanguage'
import { ocrPicture } from '../components/enginePictures'
import { DownloadConfirmDialog } from '../panels/settings/DownloadConfirmDialog'

const OCR_MODE_LIST = Object.keys(OCR_MODES) as OcrMode[]

/** An engine's picture with its image inlined (a page elsewhere can't load the app's assets). */
type Icon = { image: string; tile: boolean } | { svg: string } | { monogram: string; lang?: string }

const inlined = new Map<string, Promise<string>>()
function dataUrl(src: string): Promise<string> {
  let pending = inlined.get(src)
  if (!pending) {
    pending = fetch(src)
      .then((response) => response.blob())
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader()
            reader.onload = () => resolve(String(reader.result))
            reader.onerror = () => reject(reader.error)
            reader.readAsDataURL(blob)
          })
      )
    inlined.set(src, pending)
  }
  return pending
}

async function iconOf(mode: OcrMode): Promise<Icon> {
  const picture = ocrPicture(mode)
  if ('src' in picture) return { image: await dataUrl(picture.src), tile: picture.tile }
  if ('glyph' in picture) return { svg: renderToStaticMarkup(<>{picture.glyph}</>) }
  return picture
}

export function BrowserEngines(): JSX.Element {
  const { ocrMode, choose, confirmation } = useEngineSelection()
  const capabilities = useCapabilities()
  const [language] = useLanguage()
  const chooseRef = useRef(choose)
  useEffect(() => {
    chooseRef.current = choose
  })

  const listed = OCR_MODE_LIST.filter((mode) => engineListed(mode, capabilities, ocrMode, language.code))
  const key = `${listed.join(',')}|${ocrMode}|${capabilities.cloudAccess}`
  useEffect(() => {
    let live = true
    void Promise.all(
      listed.map(async (mode) => ({
        id: mode,
        name: ocrModeInfo(mode).name,
        // As the sidebar says it: Cloud OCR without an account is listed only while selected.
        tagline: mode === 'cloud' && !capabilities.cloudAccess ? 'Sign in under Settings → Account' : ocrModeInfo(mode).tagline,
        runs: ocrModeInfo(mode).runs,
        icon: await iconOf(mode).catch(() => ({ monogram: ocrModeInfo(mode).name.slice(0, 1) }))
      }))
    ).then((engines) => {
      if (live) void invoke('browser_engines', { engines, selected: ocrMode }).catch(() => undefined)
    })
    return () => {
      live = false
    }
    // `key` stands for everything the list is made of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  useEffect(() => {
    const stop = listen<{ mode: OcrMode }>('browser-engine-choose', ({ payload }) => {
      if (OCR_MODE_LIST.includes(payload.mode)) chooseRef.current(payload.mode)
    })
    return () => void stop.then((unlisten) => unlisten())
  }, [])

  return <DownloadConfirmDialog confirmation={confirmation} />
}

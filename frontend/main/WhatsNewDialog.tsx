/**
 * What's new: the release history built into this binary (`changelog`, CHANGELOG.md), newest
 * first, in a centred modal. The running version is marked; while no release has been cut yet the
 * Unreleased section stands in for it (`whatsNewEntries` in ui/changelog.ts), so the dialog is
 * never empty. While an update is offered, its notes from the manifest come first, as "Coming in
 * Kimochi x.y.z".
 *
 * Opened from Settings → About → Updates, and once by the main window on the first launch of a
 * new version (`useWhatsNewOnLaunch` in whatsNewOnLaunch.ts).
 */
import { useEffect, useMemo, useState, type JSX, type MouseEvent } from 'react'
import { marked } from 'marked'
import { ExternalLink } from 'lucide-react'
import { open as openUrl } from '@tauri-apps/plugin-shell'
import { Button, Callout, Dialog, DialogClose, DialogContent, Spinner } from '@kit'
import { displayHtml } from '@texthooker/lib/html'
import {
  WHATS_NEW_TITLE,
  comingTitle,
  offeredRelease,
  releaseDate,
  whatsNewEntries
} from '@ui/changelog'
import { fetchChangelog } from '../bridge/changelog'
import { useUpdateStatus } from '../bridge/updates'
import './whats-new.css'


/** Markdown (the changelog's, or the manifest's notes) as sanitised HTML. */
const notesHtml = (markdown: string): string =>
  displayHtml(marked.parse(markdown, { async: false, gfm: true }))

/** A link in the notes opens in the browser; following it would navigate this window away. */
function openLinksOutside(event: MouseEvent<HTMLElement>): void {
  const link = (event.target as HTMLElement).closest('a[href]')
  if (!link) return
  event.preventDefault()
  const href = link.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(href)) void openUrl(href).catch(() => undefined)
}

function Notes({ markdown }: { markdown: string }): JSX.Element {
  const html = useMemo(() => notesHtml(markdown), [markdown])
  return (
    <div
      className="whats-new-notes"
      onClick={openLinksOutside}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

function WhatsNewContent({ releasesUrl }: { releasesUrl?: string }): JSX.Element {
  const status = useUpdateStatus()
  const [text, setText] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    fetchChangelog()
      .then((loaded) => live && setText(loaded))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [])

  const currentVersion = status?.currentVersion ?? ''
  const entries = useMemo(
    () => (text === null ? [] : whatsNewEntries(text, currentVersion)),
    [text, currentVersion]
  )
  const coming = offeredRelease(status)

  return (
    <DialogContent
      className="whats-new"
      title={WHATS_NEW_TITLE}
      footer={
        <>
          {releasesUrl && (
            <Button
              size="sm"
              variant="ghost"
              className="k-dialog-footer-start"
              onClick={() => void openUrl(releasesUrl).catch(() => undefined)}
            >
              <ExternalLink />
              Releases on GitHub
            </Button>
          )}
          <DialogClose asChild>
            <Button variant="primary">Close</Button>
          </DialogClose>
        </>
      }
    >
      {coming && (
        <section className="whats-new-release" data-coming="">
          <header className="whats-new-head">
            <h3 className="whats-new-version">{comingTitle(coming.version)}</h3>
          </header>
          <Notes markdown={coming.notes} />
        </section>
      )}
      {entries.map((entry) => {
        const date = releaseDate(entry.date)
        return (
          <section key={entry.version || 'current'} className="whats-new-release">
            <header className="whats-new-head">
              <h3 className="whats-new-version k-num">
                {entry.version ? `Kimochi ${entry.version}` : 'This version'}
              </h3>
              {entry.current && entry.version && <span className="whats-new-meta">this version</span>}
              {date && <span className="whats-new-meta whats-new-date k-num">{date}</span>}
            </header>
            {entry.body && <Notes markdown={entry.body} />}
          </section>
        )
      })}
      {text === null && !failed && (
        <div className="whats-new-status">
          <Spinner label="Loading" />
        </div>
      )}
      {failed && <Callout tone="danger">The release notes could not be loaded.</Callout>}
      {text !== null && entries.length === 0 && !coming && (
        <p className="whats-new-status">There are no release notes yet.</p>
      )}
    </DialogContent>
  )
}

export function WhatsNewDialog({
  open,
  onOpenChange,
  releasesUrl
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The GitHub releases page, for a quiet link in the footer. */
  releasesUrl?: string
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <WhatsNewContent releasesUrl={releasesUrl} />}
    </Dialog>
  )
}

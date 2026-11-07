/**
 * "Why does Kimochi need this?" under a permission step's lede: a link that opens the longer
 * explanation in a dialog, so the step itself stays a sentence or two.
 */
import type { JSX, ReactNode } from 'react'
import { Button, Dialog, DialogClose, DialogContent, DialogTrigger } from '@kit'
import style from './WelcomeApp.module.css'

export default function PermissionWhy({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button type="button" className={`${style.link} ${style.why}`}>
          Why does Kimochi need this?
        </button>
      </DialogTrigger>
      <DialogContent
        title={title}
        footer={
          <DialogClose asChild>
            <Button variant="primary">Got it</Button>
          </DialogClose>
        }
      >
        <div className={style.whyBody}>{children}</div>
      </DialogContent>
    </Dialog>
  )
}

export function ScreenRecordingWhy({ restartAfterGrant }: { restartAfterGrant: boolean }): JSX.Element {
  return (
    <PermissionWhy title="Why Kimochi needs screen recording">
      <p>
        Kimochi reads Japanese by taking a picture of the window you choose and recognising the
        text in it. macOS only lets one app capture another app’s window with your permission,
        which it calls Screen &amp; System Audio Recording.
      </p>
      <p>
        An online OCR engine sends the pictures over the internet to be read. Kimochi records
        system audio only when you turn on Enhance with sentence audio, for Anki cards.
      </p>
      <p>
        To allow it, open System Settings → Privacy &amp; Security → Screen &amp; System Audio
        Recording and turn on Kimochi.
        {restartAfterGrant && ' macOS may ask you to reopen Kimochi afterwards.'}
      </p>
    </PermissionWhy>
  )
}

export function AccessibilityWhy(): JSX.Element {
  return (
    <PermissionWhy title="Why Kimochi asks for Accessibility">
      <p>
        When you click your source in Kimochi, it brings that exact window to the front, even one
        in full screen on a Space of its own. macOS only lets an app do that with
        Accessibility.
      </p>
      <p>
        Without it, Kimochi brings your source’s app forward instead, which may not be the window you
        were reading.
      </p>
      <p>To allow it, open System Settings → Privacy &amp; Security → Accessibility and turn on Kimochi.</p>
    </PermissionWhy>
  )
}

/**
 * Settings → Account: adding a local account (kept only on this computer), or editing one's name
 * and picture (the Local profile's too). The picture is chosen from a file or pasted, cropped to a
 * square and shrunk here, and sent to native as a `data:` URL (`account_create_local`,
 * `account_update_local`).
 */
import { useId, useRef, useState, type ClipboardEvent, type ReactNode } from 'react'
import { Camera, ImagePlus } from 'lucide-react'
import { Button, Callout, Dialog, DialogContent, Input, isComposing } from '@kit'
import { accountCreateLocal, accountUpdateLocal } from '../../bridge/account'
import { nativeError } from '../../bridge/tauri'
import { AccountAvatar } from '../../components/AccountAvatar'

/** The picture's side in pixels: sharp at every size it is shown, small enough to keep in `accounts.json`. */
const PICTURE_PX = 160
const NAME_MAX = 40

/** A picture from an image file: the centre square, shrunk to `PICTURE_PX`, as WebP (else PNG). */
async function pictureFrom(file: Blob): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('That file isn’t an image.')
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode().catch(() => {
      throw new Error('That image couldn’t be read. Try a PNG or JPEG.')
    })
    const { naturalWidth: width, naturalHeight: height } = image
    const side = Math.min(width, height)
    if (!side) throw new Error('That image is empty.')
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = PICTURE_PX
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The picture couldn’t be prepared.')
    context.imageSmoothingQuality = 'high'
    context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, PICTURE_PX, PICTURE_PX)
    // WebKit cannot encode WebP and answers with a PNG instead; both are fine.
    const webp = canvas.toDataURL('image/webp', 0.9)
    return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The first image on the clipboard, if any. */
function pastedImage(event: ClipboardEvent): File | null {
  for (const item of Array.from(event.clipboardData?.items ?? [])) {
    if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile()
  }
  return null
}

export type LocalAccountEdit =
  | { mode: 'create' }
  /** `key` null: the Local profile. */
  | { mode: 'edit'; key: string | null; name: string; avatar: string | null }

/** Mount with a `key` per edit: it starts from `edit` each time it opens. */
export function LocalAccountDialog({ edit, onClose }: { edit: LocalAccountEdit; onClose: () => void }): ReactNode {
  const creating = edit.mode === 'create'
  const [name, setName] = useState(creating ? '' : edit.name)
  const [avatar, setAvatar] = useState<string | null>(creating ? null : edit.avatar)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const file = useRef<HTMLInputElement>(null)
  // Set at once, unlike `busy`: a second Enter or click in the same moment must not add a second account.
  const sending = useRef(false)
  const id = useId()
  const trimmed = name.trim()

  const takePicture = (blob: Blob | null | undefined): void => {
    if (!blob) return
    setError('')
    pictureFrom(blob)
      .then(setAvatar)
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
  }

  const submit = (): void => {
    if (!trimmed || sending.current) return
    sending.current = true
    setBusy(true)
    setError('')
    const work = creating ? accountCreateLocal(trimmed, avatar) : accountUpdateLocal(edit.key, trimmed, avatar)
    work.then(onClose).catch((caught: unknown) => {
      setError(nativeError(caught).message)
      sending.current = false
      setBusy(false)
    })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="account-editor-dialog"
        title={creating ? 'Add a local account' : 'Edit account'}
        description={
          creating
            ? 'Kept only on this computer, with its own sessions, notebook and preferences. Kimochi switches to it once it’s added.'
            : undefined
        }
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          document.getElementById(`${id}-name`)?.focus()
        }}
        onPaste={(event) => {
          const image = pastedImage(event)
          if (!image) return
          event.preventDefault()
          takePicture(image)
        }}
        footer={
          <>
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button variant="primary" onClick={submit} disabled={!trimmed || busy}>
              {creating ? (busy ? 'Adding…' : 'Add account') : busy ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="account-editor">
          <div className="account-editor-picture">
            <button
              type="button"
              className="account-editor-avatar"
              onClick={() => file.current?.click()}
              aria-label={avatar ? 'Change picture' : 'Choose a picture'}
            >
              <AccountAvatar
                user={{
                  id: 'draft',
                  email: null,
                  displayName: trimmed || null,
                  avatarUrl: avatar,
                  plan: 'free',
                  status: 'active'
                }}
                local={!trimmed}
              />
              <span className="account-editor-avatar-badge" aria-hidden>
                <Camera />
              </span>
            </button>
            <div className="account-editor-picture-text">
              <div className="account-editor-picture-actions">
                <Button size="sm" onClick={() => file.current?.click()}>
                  <ImagePlus />
                  {avatar ? 'Change picture…' : 'Choose picture…'}
                </Button>
                {avatar && (
                  <Button size="sm" variant="ghost" onClick={() => setAvatar(null)}>
                    Remove
                  </Button>
                )}
              </div>
              <span className="k-description">Or paste an image here.</span>
            </div>
            <input
              ref={file}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              onChange={(event) => {
                takePicture(event.currentTarget.files?.[0])
                event.currentTarget.value = ''
              }}
            />
          </div>
          <label className="account-editor-label" htmlFor={`${id}-name`}>
            Name
          </label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={NAME_MAX}
            placeholder={creating ? 'Spanish practice, Yuki, Work…' : undefined}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isComposing(event)) {
                event.preventDefault()
                submit()
              }
            }}
          />
          {error && <Callout tone="danger">{error}</Callout>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

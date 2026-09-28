/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * Reading captured pixels back out of the native layer.
 *
 * Rust owns capture and keeps the latest PNG, serving it over the `capture:`
 * protocol. What is left here is the bytes themselves, for the two OCR backends
 * that run in this window: Tesseract and the OwOCR socket.
 *
 * Change detection used to come through here too — fetch the PNG, decode it,
 * draw it into a 9x8 canvas, hash the pixels — and somewhere in that sequence a
 * saved diagnostic sample recorded `Load failed`. Because a failed gate fell
 * through to the expensive call, that turned a broken hash into a remote request
 * on every tick. Which step threw was never established, so rather than guess at
 * a fix the dependency was removed: the hash and the local text reading are both
 * computed natively now, beside the pixels, and arrive with the capture itself.
 * Nothing about deciding whether to scan reaches this fetch any more.
 */

import { frameUrl } from './native.js'

/** One frame at a time is in flight, so a single-entry cache is enough. */
let cached = { id: null, blob: null }

/** The captured PNG, fetched once per frame and reused across consumers. */
export async function frameBlob(frame) {
  if (cached.id !== null && cached.id === frame?.id && cached.blob) return cached.blob
  const url = frameUrl(frame)
  if (!url) throw new Error('Captured frame has no readable URL')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Could not read captured frame (HTTP ${response.status})`)
  const blob = await response.blob()
  cached = { id: frame?.id ?? null, blob }
  return blob
}

export function forgetFrame() {
  cached = { id: null, blob: null }
}

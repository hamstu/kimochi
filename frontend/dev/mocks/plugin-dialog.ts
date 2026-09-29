/** DEV-ONLY stand-in for `@tauri-apps/plugin-dialog`: pickers cancel, confirmations accept. */
const note = (what: string, options?: unknown): void =>
  console.info(`[preview] dialog.${what}`, options ?? '')

export async function open(options?: unknown): Promise<null> {
  note('open', options)
  return null
}
export async function save(options?: unknown): Promise<null> {
  note('save', options)
  return null
}
export async function message(text: string, options?: unknown): Promise<'Ok'> {
  note('message', { text, options })
  return 'Ok'
}
export async function ask(text: string, options?: unknown): Promise<boolean> {
  note('ask', { text, options })
  return true
}
export async function confirm(text: string, options?: unknown): Promise<boolean> {
  note('confirm', { text, options })
  return true
}

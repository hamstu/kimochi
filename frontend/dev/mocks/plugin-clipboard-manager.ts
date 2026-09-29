/** DEV-ONLY stand-in for `@tauri-apps/plugin-clipboard-manager`, backed by an in-memory string. */
let clipboard = ''

export async function readText(): Promise<string> {
  return clipboard
}
export async function writeText(text: string): Promise<void> {
  clipboard = text
  console.info('[preview] clipboard.writeText', text)
}
export async function writeHtml(html: string): Promise<void> {
  clipboard = html
}
export async function clear(): Promise<void> {
  clipboard = ''
}
export async function readImage(): Promise<never> {
  throw new Error('preview: no image on the clipboard')
}
export async function writeImage(): Promise<void> {}

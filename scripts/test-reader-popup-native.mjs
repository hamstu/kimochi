/** Native macOS regression. Run after `npm run bundle`; never captures or calls OCR. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') {
  throw new Error('This native popup regression currently requires macOS')
}
const executable = fileURLToPath(new URL(
  '../src-tauri/target/debug/bundle/macos/Kimochi.app/Contents/MacOS/kimochi',
  import.meta.url
))
const result = spawnSync(executable, [], {
  env: { ...process.env, KIMOCHI_READER_POPUP_SMOKE: '1' },
  encoding: 'utf8',
  timeout: 25000,
  killSignal: 'SIGKILL'
})
if (result.error) throw result.error
if (result.status !== 0 || !result.stderr.includes('reader-popup-smoke: Ok(())')) {
  throw new Error(`Popup regression failed (${result.signal || result.status}):\n${result.stderr}`)
}
console.log('Native popup: show, focus, inside/outside clicks and hide passed (3 cycles).')

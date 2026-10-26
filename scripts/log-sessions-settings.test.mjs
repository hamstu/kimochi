// Settings → Log & Sessions: the page lists the sessions (the same list as the Log's "Manage
// sessions" dialog) in place of the old "Reset Log settings" button, and keeps its `log` id.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('the Log page is "Log & Sessions" and still answers to log', async () => {
  const nav = await read('frontend/panels/settings/settingsNav.tsx')
  assert.ok(nav.includes("{ value: 'log', label: 'Log & Sessions'"), 'the nav entry is not Log & Sessions on the log value')
  assert.match(nav, /texthooker: 'log'/, 'older stored page names no longer land on the Log page')
  const tab = await read('frontend/panels/settings/LogTab.tsx')
  assert.ok(tab.includes('title="Log & Sessions"'), 'the page title is not Log & Sessions')
  const studio = await read('frontend/dev/studio/surfaces.ts')
  assert.ok(studio.includes("['log', 'Log & Sessions']"), 'the studio still names the page Log')
})

test('the Log page has no reset, and the reset helper is gone', async () => {
  const tab = await read('frontend/panels/settings/LogTab.tsx')
  assert.ok(!/Reset Log settings|resetSettings|ConfirmDialog/.test(tab), 'the Log page still offers a reset')
  const lib = await read('frontend/texthooker/lib/settings.ts')
  assert.ok(!lib.includes('resetSettings'), 'resetSettings is still exported')
})

test('the Log page and the Manage sessions dialog share one session list', async () => {
  const tab = await read('frontend/panels/settings/LogTab.tsx')
  assert.match(tab, /<SettingsSection\s+title="Sessions"/, 'no Sessions section')
  assert.match(tab, /<SessionList[\s\S]*?switchable[\s\S]*?\/>/, 'the page does not render the switchable session list')
  assert.match(tab, /createSession\(\)/, 'the page cannot start a new session')
  const modal = await read('frontend/texthooker/components/SessionManagerModal.tsx')
  assert.ok(modal.includes('<SessionList'), 'the dialog no longer uses the shared list')
  const list = await read('frontend/texthooker/components/SessionList.tsx')
  for (const op of ['renameSession(', 'reorderSessions(', 'deleteSession(', 'switchSession(']) {
    assert.ok(list.includes(op), `the session list lost ${op}`)
  }
  assert.match(list, /<ConfirmDialog[\s\S]*?Delete session/, 'deleting a session is not confirmed')
  assert.ok(list.includes("import \"./session-list.css\""), 'the list does not bring its own styles to Settings')
})

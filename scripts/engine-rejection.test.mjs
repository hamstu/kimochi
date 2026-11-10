import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEngineRejection } from '../ui/engine-rejection.js'

const error = (stack) => Object.assign(new Error('x'), { stack })

test("Yomitan's own failures are told apart from Kimochi's", () => {
  // WebKit (macOS, Linux) and Chromium-style (WebView2) stacks from Yomitan's cross-frame API.
  assert.ok(isEngineRejection(error('_onError@tauri://localhost/js/comm/cross-frame-api.js:250:49\n@tauri://localhost/js/comm/cross-frame-api.js:106:71')))
  assert.ok(isEngineRejection(error('Error: Acknowledgement timeout (popupFactoryHide)\n    at CrossFrameAPIPort._onError (http://tauri.localhost/js/comm/cross-frame-api.js:250:49)')))
  // Kimochi's own code, even when it calls into Yomitan further down.
  assert.ok(!isEngineRejection(error('save@tauri://localhost/assets/index-abc.js:1:200\n@tauri://localhost/js/comm/api.js:10:1')))
  assert.ok(!isEngineRejection(error('Error: failed\n    at load (http://127.0.0.1:1430/frontend/texthooker/App.tsx:80:5)')))
  assert.ok(!isEngineRejection('a plain string'))
  assert.ok(!isEngineRejection(undefined))
})

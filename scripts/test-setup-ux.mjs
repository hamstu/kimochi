/**
 * Browser regressions for welcome recovery, source discovery and Settings navigation.
 * Run: node scripts/test-setup-ux.mjs (Chrome/Chromium required; CHROME overrides its path).
 * Uses the real preview and React components, with only native responses fault-injected.
 * Optional: UX_PREVIEW_URL=http://localhost:5299, UX_SCREENSHOTS=evidence/ux.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import { launchChrome, evaluate, waitFor } from './cdp.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const server = process.env.UX_PREVIEW_URL
  ? null
  : await createServer({
      configFile: path.join(root, 'vite.preview.config.ts'),
      server: { port: 0, open: false },
      logLevel: 'error'
    })
await server?.listen()
const origin = process.env.UX_PREVIEW_URL ?? `http://localhost:${server.httpServer.address().port}`
const shots = process.env.UX_SCREENSHOTS
if (shots) await mkdir(shots, { recursive: true })
const browser = await launchChrome()
let passed = 0
const codes = { Enter: 13, Tab: 9, Escape: 27, ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, Home: 36, End: 35 }

async function key(page, name, modifiers = 0) {
  for (const type of ['keyDown', 'keyUp']) {
    await page.send('Input.dispatchKeyEvent', {
      type,
      key: name,
      code: name,
      windowsVirtualKeyCode: codes[name],
      modifiers,
      ...(name === 'Enter' && type === 'keyDown' ? { text: '\r' } : {})
    })
  }
}
async function click(page, selector) {
  await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).click()`)
}
async function focus(page, selector) {
  await evaluate(page, `document.querySelector(${JSON.stringify(selector)}).focus()`)
}
async function screenshot(page, name) {
  if (!shots) return
  await evaluate(page, 'document.fonts.ready.then(() => true)')
  const { data } = await page.send('Page.captureScreenshot', { format: 'png' })
  await writeFile(path.join(shots, `${name}.png`), Buffer.from(data, 'base64'))
}
async function visibleWithinWindow(page, selector) {
  // Radix positions a newly mounted floating menu on the next layout frame.
  await evaluate(
    page,
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))'
  )
  const boxes = await evaluate(
    page,
    `Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(el => {
    const r = el.getBoundingClientRect(); return {text: el.textContent, x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight}
  })`
  )
  assert.ok(boxes.length, `No elements for ${selector}`)
  for (const box of boxes) {
    assert.ok(
      box.x >= -1 && box.right <= box.width + 1 && box.y >= -1 && box.bottom <= box.height + 1,
      `Clipped ${selector}: ${JSON.stringify(box)}`
    )
  }
}
async function scenario(name, size, run) {
  const page = await browser.newPage()
  const errors = []
  await page.send('Runtime.enable')
  page.on('Runtime.exceptionThrown', ({ exceptionDetails }) => errors.push(exceptionDetails.text))
  await page.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 1, mobile: false })
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  const open = async (url, ready) => {
    await page.send('Page.navigate', { url: `${origin}/dev/${url}` })
    await waitFor(page, ready)
  }
  try {
    await run(page, open)
    assert.deepEqual(errors, [], 'Uncaught browser errors')
    console.log(`PASS ${name}`)
    passed++
  } catch (error) {
    await screenshot(page, `FAILED-${name.replaceAll(/[^a-z0-9-]/gi, '-')}`)
    throw error
  } finally {
    await browser.send('Target.closeTarget', { targetId: page.targetId })
  }
}

try {
  for (const theme of ['light', 'dark']) {
    for (const narrow of [false, true]) {
      const variant = `${theme}-${narrow ? 'narrow' : 'default'}`
      const appearance = `theme=${theme}&scale=${narrow ? 'xlarge' : 'medium'}`
      await scenario(
        `dictionary-${variant}`,
        { width: narrow ? 600 : 920, height: narrow ? 460 : 700 },
        async (page, open) => {
          await open(
            `welcome.html?step=dictionaries&dict=none&${appearance}`,
            '!!document.querySelector("[role=alert]")'
          )
          // Exercise Linux's always-active touchscreen filter on every host. Rapid keyboard
          // clicks have detail=0 and must pass even when they arrive within DUPLICATE_MS.
          await evaluate(
            page,
            `import(${JSON.stringify(`/@fs/${root}ui/pointer-dedupe.ts`)}).then(m => { m.installPointerFilter(window, {active:true}); return true })`
          )
          assert.equal(
            await evaluate(page, 'document.querySelectorAll("[role=radio]").length'),
            0,
            'A failed check must not pretend no dictionaries are installed'
          )
          await visibleWithinWindow(page, 'footer button, footer a')
          await screenshot(page, `dictionary-error-${variant}`)
          assert.equal(await evaluate(page, 'document.querySelector("details").open'), false)
          await focus(page, 'details summary')
          await key(page, 'Enter')
          assert.equal(await evaluate(page, 'document.querySelector("details").open'), true)
          await key(page, 'Enter')
          assert.equal(await evaluate(page, 'document.querySelector("details").open'), false)
          await evaluate(
            page,
            `window.__catalogCalls = 0; window.__extensionHost = {
          toBackend: () => { window.__catalogCalls++; return new Promise((resolve,reject) => {
            window.__resolveCatalog = resolve; window.__rejectCatalog = reject
          }) }
        }`
          )
          for (let failure = 0; failure < 2; failure++) {
            await focus(page, 'footer button')
            await key(page, 'Enter')
            await waitFor(
              page,
              `window.__catalogCalls === ${failure + 1} && !!document.querySelector('footer button:disabled')`
            )
            assert.equal(
              await evaluate(page, 'document.querySelector("footer button").textContent'),
              'Checking dictionaries…'
            )
            await click(page, 'footer button')
            assert.equal(await evaluate(page, 'window.__catalogCalls'), failure + 1, 'Pending checks cannot duplicate')
            await evaluate(page, `window.__rejectCatalog(new Error('Setup service is still starting'))`)
            await waitFor(page, `document.querySelector('footer button')?.textContent === 'Retry dictionary check'`)
            assert.match(await evaluate(page, 'document.querySelector("[role=alert]").textContent'), /still starting/)
          }
          await click(page, 'footer button')
          await waitFor(page, 'window.__catalogCalls === 3')
          await evaluate(
            page,
            `window.__resolveCatalog({catalog:[{id:'jitendex',title:'Jitendex',description:'Japanese–English'}],dictionaries:[]})`
          )
          await waitFor(page, 'document.querySelectorAll("[role=radio]").length === 3')
          assert.equal(await evaluate(page, 'document.querySelector("footer button").textContent'), 'Install Jitendex')
          assert.equal(await evaluate(page, 'document.querySelectorAll("[role=alert]").length'), 0)
          // The recovered list retains its radio keyboard behavior and its explicit later route.
          await focus(page, '[role=radio][aria-checked=true]')
          await key(page, 'End')
          assert.match(await evaluate(page, 'document.activeElement.textContent'), /Do it later/)
          assert.equal(await evaluate(page, 'document.activeElement.getAttribute("aria-checked")'), 'true')
          await visibleWithinWindow(page, 'footer button, footer a')
          await screenshot(page, `dictionary-recovered-${variant}`)
          await click(page, 'footer button')
          await waitFor(page, '!!document.querySelector("[data-step=done]")')
        }
      )

      await scenario(
        `welcome-focus-${variant}`,
        { width: narrow ? 600 : 920, height: narrow ? 460 : 700 },
        async (page, open) => {
          await open(
            `welcome.html?step=dictionaries&${appearance}`,
            'document.querySelectorAll("[role=radio]").length === 3'
          )
          assert.equal(await evaluate(page, 'document.activeElement.tagName'), 'H1')
          await evaluate(page, `document.querySelector('[data-step]').scrollTop = 1000`)
          await focus(page, 'footer a') // Back is persistent across steps.
          await key(page, 'Enter')
          await waitFor(page, '!!document.querySelector("[data-step=engine]")')
          assert.equal(await evaluate(page, 'document.activeElement.tagName'), 'H1')
          assert.equal(await evaluate(page, 'document.querySelector("[data-step]").scrollTop'), 0)
          await key(page, 'Tab')
          assert.notEqual(
            await evaluate(page, 'document.activeElement.closest("footer") !== null'),
            true,
            'Tab after a route change should enter its content before the footer'
          )
          const active = await evaluate(page, 'document.activeElement.outerHTML')
          // A native status update must not re-announce the heading or steal the keyboard.
          await evaluate(page, `window.dispatchEvent(new Event('resize'))`)
          assert.equal(await evaluate(page, 'document.activeElement.outerHTML'), active)
          await screenshot(page, `welcome-focus-${variant}`)
        }
      )

      await scenario(
        `anki-tabs-${variant}`,
        { width: narrow ? 820 : 1000, height: narrow ? 560 : 760 },
        async (page, open) => {
          await open(
            `panel.html?window=settings&tab=anki&${appearance}`,
            '!!document.querySelector(".k-settings-tabs")'
          )
          const tabs = '.k-settings-tabs [role=tab]'
          await focus(page, `${tabs}[aria-selected=true]`)
          await waitFor(page, `document.querySelectorAll('${tabs}[tabindex="0"]').length === 1`)
          for (const [press, expected] of [
            ['ArrowRight', 'Mining'],
            ['End', 'Card enhancement'],
            ['ArrowRight', 'AnkiConnect'],
            ['ArrowLeft', 'Card enhancement'],
            ['Home', 'AnkiConnect']
          ]) {
            await key(page, press)
            await waitFor(
              page,
              `document.querySelector('.k-settings-tabs [aria-selected=true]')?.textContent === ${JSON.stringify(expected)}`
            )
            assert.equal(await evaluate(page, 'document.activeElement.textContent'), expected)
            assert.equal(
              await evaluate(
                page,
                `document.getElementById(document.activeElement.getAttribute('aria-controls'))?.getAttribute('aria-labelledby') === document.activeElement.id`
              ),
              true
            )
            assert.equal(await evaluate(page, 'document.querySelector(".k-settings-tabbed-scroll").scrollTop'), 0)
          }
          await key(page, 'Tab')
          assert.equal(await evaluate(page, 'document.activeElement.className'), 'k-settings-tabbed-scroll')
          assert.equal(await evaluate(page, 'getComputedStyle(document.activeElement).outlineStyle'), 'solid')
          assert.equal(
            await evaluate(page, 'getComputedStyle(document.querySelector(".k-settings-tabbed")).animationName'),
            'none'
          )
          await visibleWithinWindow(page, tabs)
          await screenshot(page, `anki-tabs-${variant}`)
          await key(page, 'Tab', 8)
          assert.equal(await evaluate(page, 'document.activeElement.textContent'), 'AnkiConnect')
        }
      )

      await scenario(
        `source-retry-${variant}`,
        { width: narrow ? 720 : 1000, height: narrow ? 480 : 700 },
        async (page, open) => {
          await open(`panel.html?nosource=1&empty=1&${appearance}`, '!!document.querySelector(".src-empty")')
          await evaluate(
            page,
            `window.__sourceCalls = 0; window.__sourceMode = 'empty';
          const invoke = window.__TAURI_INTERNALS__.invoke;
          window.__TAURI_INTERNALS__.invoke = (cmd,args,options) => {
            if(cmd !== 'source_catalog') return invoke(cmd,args,options);
            window.__sourceCalls++;
            if(window.__sourceMode === 'empty') return Promise.resolve([]);
            if(window.__sourceMode === 'fail') return Promise.reject('native: Capture service temporarily unavailable.');
            if(window.__sourceMode === 'permission') return Promise.reject('permission: Screen recording denied.');
            if(window.__sourceMode === 'pending') return new Promise(resolve => window.__resolveSources = resolve);
            return invoke(cmd,args,options);
          }`
          )
          await focus(page, '.src-empty')
          await key(page, 'Enter')
          await waitFor(page, '!!document.querySelector(".src-type")')
          await focus(page, '.src-type')
          await key(page, 'ArrowRight')
          await waitFor(
            page,
            'document.querySelector(".sg-status")?.textContent.includes("No windows or screens found")'
          )
          await waitFor(page, 'document.querySelector(".sg-refresh")?.getBoundingClientRect().top >= 0')
          await visibleWithinWindow(page, '.sg-refresh')
          await screenshot(page, `source-empty-${variant}`)
          for (let failure = 0; failure < 2; failure++) {
            await evaluate(page, `window.__sourceMode='fail'`)
            await focus(page, '.sg-refresh')
            await key(page, 'Enter')
            await waitFor(page, '!!document.querySelector(".sg-error")')
            assert.match(await evaluate(page, 'document.querySelector(".sg-error").textContent'), /Try refreshing/)
            assert.equal(await evaluate(page, 'document.activeElement.classList.contains("sg-refresh")'), true)
          }
          await screenshot(page, `source-error-${variant}`)
          await evaluate(page, `window.__sourceMode='pending'`)
          await key(page, 'Enter')
          await waitFor(page, 'document.querySelector(".sg-refresh")?.getAttribute("aria-disabled") === "true"')
          const calls = await evaluate(page, 'window.__sourceCalls')
          await key(page, 'Enter')
          assert.equal(await evaluate(page, 'window.__sourceCalls'), calls)
          await evaluate(
            page,
            `window.__resolveSources([{id:'window:101',kind:'window',name:'Recovered game',app:'Test game'}])`
          )
          await waitFor(page, 'document.querySelectorAll(".sg-tile").length === 1')
          assert.equal(await evaluate(page, 'document.querySelectorAll(".sg-error").length'), 0)
          await key(page, 'ArrowDown')
          await waitFor(page, 'document.activeElement.classList.contains("sg-tile")')
          await screenshot(page, `source-recovered-${variant}`)
          await key(page, 'Enter')
          await waitFor(page, '!document.querySelector(".sg-scroll") && !document.querySelector(".src-empty")')
        }
      )
    }
  }
  for (const theme of ['light', 'dark']) {
    for (const stage of ['save', 'log', 'welcome']) {
      await scenario(`completion-${stage}-${theme}`, { width: 600, height: 520 }, async (page, open) => {
        await open(`welcome.html?step=done&theme=${theme}&scale=xlarge`, `!!document.querySelector('a[href="#/main"]')`)
        await evaluate(
          page,
          `window.__completionCalls=[]; window.__failStage=${JSON.stringify(stage)};
          const invoke=window.__TAURI_INTERNALS__.invoke;
          window.__TAURI_INTERNALS__.invoke=(cmd,args,options)=>{
            if(cmd==='settings_set'&&args.key==='hasCompletedOnboarding') {
              window.__completionCalls.push('save');
              return new Promise((resolve,reject)=>{window.__finishSave=()=>window.__failStage==='save'?reject('Disk unavailable'):resolve()});
            }
            if(cmd==='panel'&&((args.label==='log'&&args.action==='show')||(args.label==='welcome'&&args.action==='hide'))) {
              window.__completionCalls.push(args.label);
              if(window.__failStage===args.label)return Promise.reject(args.label+' window unavailable');
            }
            return invoke(cmd,args,options);
          };
          const finish=document.querySelector('a[href="#/main"]');finish.click();finish.click()`
        )
        await waitFor(page, `document.querySelector('h1')?.textContent==='Opening Kimochi…'`)
        assert.deepEqual(
          await evaluate(page, 'window.__completionCalls'),
          ['save'],
          'Double Finish and effect replay share one operation'
        )
        assert.equal(
          await evaluate(page, 'document.querySelectorAll("footer a, footer button").length'),
          0,
          'Pending first handoff has no navigation that could start another one'
        )
        await screenshot(page, `completion-pending-${stage}-${theme}`)
        const expected = stage === 'save' ? ['save'] : stage === 'log' ? ['save', 'log'] : ['save', 'log', 'welcome']
        for (let failure = 0; failure < 2; failure++) {
          await evaluate(page, 'window.__finishSave()')
          await waitFor(page, `document.querySelector('h1')?.textContent==='Couldn’t finish setup'`)
          assert.deepEqual(
            await evaluate(page, 'window.__completionCalls'),
            Array.from({ length: failure + 1 }, () => expected).flat()
          )
          assert.match(
            await evaluate(page, 'document.querySelector("[role=alert]").textContent'),
            stage === 'save' ? /save/ : stage === 'log' ? /couldn't open/ : /couldn't close/
          )
          if (failure > 0)
            assert.equal(
              await evaluate(page, 'document.activeElement.textContent'),
              'Try again',
              'Retry retains keyboard focus after failure'
            )
          await visibleWithinWindow(page, 'footer a, footer button')
          await screenshot(page, `completion-${stage}-${theme}`)
          await focus(page, 'footer button')
          await key(page, 'Enter')
          await waitFor(page, `document.querySelector('footer button')?.getAttribute('aria-busy')==='true'`)
          await key(page, 'Enter')
          assert.equal(
            await evaluate(page, 'window.__completionCalls.filter(x=>x==="save").length'),
            failure + 2,
            'Repeated Enter while pending does not duplicate work'
          )
        }
        await evaluate(page, `window.__failStage=null; window.__finishSave()`)
        await waitFor(page, `window.__completionCalls.length===${expected.length * 2 + 3}`)
        assert.deepEqual(await evaluate(page, 'window.__completionCalls.slice(-3)'), ['save', 'log', 'welcome'])
        assert.equal(await evaluate(page, 'document.querySelectorAll("[role=alert]").length'), 0)
      })
    }
  }
  console.log(`${passed} browser scenarios passed.`)
} finally {
  await browser.close()
  await server?.close()
}

/**
 * Every screenshot in the docs, declared once. `npm run docs:screenshots` renders each in light and
 * dark into src/assets/screenshots/<id>-<theme>.webp; pages show one with
 * <Screenshot id="<id>" alt="…" /> (src/components/Screenshot.astro).
 *
 * A shot:
 *   id        file name and the id pages use
 *   page      a preview-harness page and its parameters (frontend/dev/, documented at the top of
 *             frontend/dev/preview-setup.ts), e.g. 'panel.html?window=log'. `theme` is added.
 *   server    'site' for a page of the marketing site (its live demo) instead of the harness
 *   size      [width, height] of the app window in CSS pixels (captured at 2×)
 *   crop      { x, y, width, height }: show only this part of the window (a detail shot)
 *   clipTo    a target: show only that element, scrolled into view (for the site's demo)
 *   frame     'window' (default: rounded corners, hairline, shadow), 'titlebar' (adds a plain
 *             title bar for pages without their own, with `title`), or 'bare'
 *   pad       space around the window, px (default 48), or [top, right, bottom, left]: room for
 *             the shadow and for notes
 *   ready     a target to wait for before anything else
 *   actions   played in order with real input: { click }, { rightClick }, { hover }, { key },
 *             { type }, { wait: ms }, { waitFor }, { run: 'js in the page' }; `after` ms each
 *   marks     drawn last, over the window:
 *             { type: 'glow', target }                       soft glowing outline
 *             { type: 'focus', target }                      dims everything else, with a glow
 *                                                            (glow: false for none)
 *             { type: 'glow', target, dim: true }            the same, spelled from a glow
 *             { type: 'badge', target, n, at?, nudge? }      numbered dot on a corner, moved by
                                                            nudge [dx, dy] px off the text it marks
 *             { type: 'note', target, text, n?, side? }      callout label with a leader line
 *             { type: 'cursor', target, fx?, fy? }           a mouse pointer over the target
 *   themes    limit to ['light'] or ['dark']
 *
 * A target is a CSS selector inside the app, or { selector, text?, index?, pad? }.
 */

/**
 * Shows a lookup in the Log (a `run` action): the first line with `word` gets the word selected, in
 * the Log's own selection colour, and the reader pop-up page floating above or below it, as a pop-up
 * opens. Leaves #k-lookup-word over the word for a cursor mark.
 */
const SHOW_LOOKUP = (word) => `(() => {
  const word = ${JSON.stringify(word)}
  const line = [...document.querySelectorAll('.line')].find((l) => l.textContent.includes(word))
  const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walk.nextNode()) && !node.data.includes(word));
  const range = document.createRange()
  range.setStart(node, node.data.indexOf(word))
  range.setEnd(node, node.data.indexOf(word) + word.length)
  const r = range.getBoundingClientRect()
  const mark = document.createElement('div')
  mark.id = 'k-lookup-word'
  const tint = getComputedStyle(line).getPropertyValue('--accent-a5') || 'rgb(62 99 221 / 0.25)'
  Object.assign(mark.style, { position: 'fixed', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', background: tint, borderRadius: '2px', pointerEvents: 'none', zIndex: 9998 })
  document.body.append(mark)
  // The reader page draws its card 13 px inside its window: show only the card, with a pop-up's shadow.
  const inset = 13, w = 404, h = 346
  const above = r.top > innerHeight / 2
  const box = document.createElement('div')
  const dark = document.documentElement.dataset.theme === 'dark' || /theme=dark/.test(location.search)
  Object.assign(box.style, { position: 'fixed', left: Math.min(r.left - 12, innerWidth - w - 8) + 'px', top: (above ? r.top - h - 6 : r.bottom + 6) + 'px', width: w + 'px', height: h + 'px', overflow: 'hidden', borderRadius: '9px', boxShadow: dark ? '0 12px 32px rgb(0 0 0 / 0.55)' : '0 12px 32px rgb(15 17 26 / 0.22)', zIndex: 9999 })
  const popup = document.createElement('iframe')
  popup.src = location.pathname.replace(/[^/]*$/, 'reader-popup.html') + location.search
  Object.assign(popup.style, { position: 'absolute', left: -inset + 'px', top: -inset + 'px', width: w + inset * 2 + 'px', height: h + inset * 2 + 'px', border: '0' })
  box.append(popup)
  document.body.append(box)
})()`

/** Hides the live demo's window resize grips (a `run` prefix for shots of the site's demo). */
const HIDE_GRIPS = `document.head.insertAdjacentHTML('beforeend', '<style>.kd-resize{display:none!important}</style>');`

const MAIN = [900, 560]
const SETTINGS = [820, 700]
const WELCOME = [720, 620]
/** The main window's sidebar alone (its default width is 240px). */
const SIDEBAR = { x: 0, y: 0, width: 240, height: 560 }

/** Something on each Settings page that only renders once it has loaded. */
const SETTINGS_READY = {
  general: '#general-sound-effects',
  sources: '.input-source-list',
  ocr: '.engine-chooser',
  log: '#log-font-size',
  dictionary: '.engine-setting-label, .dictionary-engine-action',
  assist: '#assist-deepl',
  controls: '#gamepad-enabled',
  account: '.settings-page-scroll h2, .settings-page-scroll h3'
}
/** Settings → Account shows a Server section in development builds only (the harness is one). */
const HIDE_DEV_SERVER = {
  run: `for (const h of document.querySelectorAll('.settings-page-scroll h2, .settings-page-scroll h3, .settings-page-scroll [class*="section-title"]')) {
          if (h.textContent.trim() === 'Server') (h.closest('section') ?? h.parentElement).style.display = 'none'
        }`
}

const switchRow = (text) => ({ selector: '.src-rows > .src-row', text, pad: 1 })
const sourceAction = (text) => ({ selector: '.src-actions > .src-action', text })
const settingsTab = (tab, extra = '') => `panel.html?window=settings&tab=${tab}${extra}`

export const SHOTS = [
  // ------------------------------------------------------------------ main window
  { id: 'main-window', page: 'panel.html?window=log', size: MAIN, ready: '.line' },
  {
    id: 'main-window-tour',
    page: 'panel.html?window=log',
    size: MAIN,
    ready: '.line',
    marks: [
      { type: 'badge', target: { selector: '.src-card', pad: 2 }, n: 1, nudge: [-10, 0] },
      { type: 'badge', target: { selector: '.src-rows', pad: 2 }, n: 2, nudge: [-10, 0] },
      { type: 'badge', target: { selector: '#sb-ocr-label', pad: 4 }, n: 3, nudge: [-10, 0] },
      { type: 'badge', target: { selector: '#sb-dictionary-label', pad: 4 }, n: 4, nudge: [-10, 0] },
      { type: 'badge', target: { selector: '.main-tab', index: 0, pad: -4 }, n: 5 },
      { type: 'badge', target: { selector: '.line', text: 'ラジ館' }, n: 6, at: 'top-right', nudge: [-28, 22] },
      { type: 'badge', target: { selector: '.log-stats', pad: 4 }, n: 7, nudge: [-12, 0] }
    ]
  },
  {
    id: 'source-card',
    page: 'panel.html?window=log',
    size: MAIN,
    crop: SIDEBAR,
    ready: '.src-card-live',
    marks: [{ type: 'glow', target: { selector: '.src-card', pad: 1 }, radius: 12 }]
  },
  {
    id: 'overlay-switch',
    page: 'panel.html?window=log',
    size: MAIN,
    crop: SIDEBAR,
    ready: '.src-card-live',
    marks: [{ type: 'glow', target: switchRow('Show overlay'), radius: 8 }]
  },
  {
    id: 'sidebar-callouts',
    page: 'panel.html?window=log&auto=0',
    size: MAIN,
    crop: SIDEBAR,
    pad: [48, 270, 48, 48],
    ready: '.src-card-live',
    marks: [
      { type: 'note', target: { selector: '.src-shot' }, n: 1, text: 'Live preview of your game' },
      { type: 'note', target: { selector: '.src-actions' }, n: 2, text: 'Crop to the dialogue' },
      { type: 'note', target: { selector: '.src-scan' }, n: 3, text: 'Scan once (⇧⌘8)' },
      { type: 'note', target: switchRow('Auto OCR'), n: 4, text: 'Scan on every change' },
      { type: 'note', target: switchRow('Show overlay'), n: 5, text: 'Draw text over the game' },
      { type: 'note', target: { selector: '.sb-engine-select', index: 0 }, n: 6, text: 'The OCR engine' },
      { type: 'note', target: { selector: '.sb-engine-select', index: 1 }, n: 7, text: 'The pop-up dictionary' }
    ]
  },
  {
    id: 'source-empty',
    page: 'panel.html?window=log&nosource=1&empty=1',
    size: MAIN,
    ready: '.src-empty',
    marks: [{ type: 'glow', target: { selector: '.src-empty', pad: 2 }, radius: 10 }]
  },
  {
    id: 'source-menu',
    page: 'panel.html?window=log',
    size: MAIN,
    ready: '.src-card-live',
    actions: [{ click: sourceAction('Change source'), after: 500 }],
    marks: [{ type: 'glow', target: { selector: '.src-menu', pad: 0 }, radius: 10 }]
  },
  {
    id: 'source-grid',
    page: 'panel.html?window=log',
    size: [900, 640],
    ready: '.src-card-live',
    actions: [
      { click: sourceAction('Change source'), after: 400 },
      { click: { selector: '.src-type', index: 0 }, after: 900 }
    ]
  },
  {
    id: 'crop-menu',
    page: 'panel.html?window=log&crop=1',
    size: MAIN,
    crop: { x: 0, y: 0, width: 520, height: 560 },
    ready: '.src-card-live',
    actions: [{ click: sourceAction('Crop area'), after: 500 }],
    // The three steps on the Sources page: the Crop area button, Change crop area… in its menu,
    // and the crop it set, outlined on the preview.
    marks: [
      { type: 'glow', target: { selector: '.src-region', pad: 1 }, radius: 3 },
      { type: 'badge', target: sourceAction('Crop area'), n: 1, nudge: [-6, -2] },
      { type: 'badge', target: { selector: '[role="menuitem"]', text: 'Change crop area' }, n: 2, nudge: [-6, 0] },
      { type: 'badge', target: { selector: '.src-region', pad: 1 }, n: 3, at: 'top-right' }
    ]
  },
  {
    id: 'scan-button',
    page: 'panel.html?window=log&auto=0',
    size: MAIN,
    crop: SIDEBAR,
    ready: '.src-scan',
    marks: [{ type: 'focus', target: { selector: '.src-scan', pad: 2 }, radius: 10 }]
  },
  {
    id: 'quickshot-card',
    page: 'panel.html?window=log&quickshot=1',
    size: MAIN,
    crop: SIDEBAR,
    ready: '.src-card'
  },
  {
    id: 'clipboard-card',
    page: 'panel.html?window=log&input=clipboard',
    size: MAIN,
    crop: SIDEBAR,
    ready: '.src-card'
  },
  {
    id: 'websocket-card',
    page: 'panel.html?window=log&input=websocket',
    size: MAIN,
    crop: SIDEBAR,
    ready: '.src-card'
  },
  {
    id: 'ocr-picker',
    page: 'panel.html?window=log',
    size: MAIN,
    ready: '.sb-engine-select',
    actions: [{ click: 'button[aria-label="OCR model"]', after: 500 }]
  },
  {
    id: 'dictionary-picker',
    page: 'panel.html?window=log',
    size: MAIN,
    ready: '.sb-engine-select',
    actions: [{ click: 'button[aria-label="Dictionary"]', after: 500 }]
  },
  {
    id: 'log-empty',
    page: 'panel.html?window=log&empty=1',
    size: MAIN,
    ready: '.log-empty'
  },
  {
    id: 'line-actions',
    page: 'panel.html?window=log',
    size: MAIN,
    ready: '.line',
    // A line in the middle of the window, so the menu opens below it and stays inside.
    actions: [{ rightClick: { selector: '.line', text: 'ダルはモニター' }, after: 500 }],
    marks: [{ type: 'glow', target: { selector: '[role="menu"]' }, radius: 10 }]
  },
  {
    id: 'line-translated',
    page: 'panel.html?window=log',
    size: MAIN,
    ready: '.line-translated',
    marks: [{ type: 'focus', target: { selector: '.line-translated', pad: 2 }, radius: 6 }]
  },
  {
    id: 'notebook-chips',
    page: 'panel.html?window=log',
    size: MAIN,
    ready: '.notebook-chip',
    marks: [{ type: 'glow', target: { selector: '.notebook-chip', index: 0, pad: 2 }, radius: 6 }]
  },
  {
    id: 'log-footer',
    page: 'panel.html?window=log',
    size: MAIN,
    crop: { x: 240, y: 470, width: 660, height: 90 },
    pad: 40,
    ready: '.log-stats'
  },
  {
    id: 'session-menu',
    page: 'panel.html?window=log',
    size: MAIN,
    ready: '.log-session-trigger',
    actions: [{ click: '.log-session-trigger', after: 500 }],
    marks: [{ type: 'glow', target: '.main-session-menu', radius: 10 }]
  },
  {
    id: 'log-more-menu',
    page: 'panel.html?window=log',
    size: MAIN,
    ready: '.log-stats',
    actions: [{ click: '.log-root button[aria-label="More"]', after: 500 }],
    marks: [{ type: 'glow', target: '.log-more-menu', radius: 10 }]
  },
  {
    id: 'activity',
    page: 'panel.html?window=log&activity=1',
    size: MAIN,
    ready: '.line',
    actions: [{ wait: 3500 }, { click: '.activity-ticker', after: 600 }]
  },
  {
    id: 'update-notice',
    page: 'panel.html?window=log&update=available',
    size: MAIN,
    crop: SIDEBAR,
    ready: '[aria-label="Update"]',
    marks: [{ type: 'glow', target: { selector: '[aria-label="Update"]', pad: 1 }, radius: 10 }]
  },
  {
    id: 'mini-mode',
    page: 'panel.html?window=log',
    size: [260, 470],
    ready: '.src-card-live',
    actions: [{ click: 'button[aria-label="Mini mode"]', after: 900 }]
  },

  // ------------------------------------------------------------------ notebook
  { id: 'notebook', page: 'panel.html?window=log&view=notebook', size: MAIN, ready: '.nb-row' },
  {
    id: 'notebook-editor',
    page: 'panel.html?window=log&view=notebook',
    size: [1000, 640],
    ready: '.nb-row',
    actions: [{ click: { selector: '.nb-row', index: 0 }, after: 700 }]
  },
  {
    id: 'notebook-empty',
    page: 'panel.html?window=log&view=notebook&empty=1',
    size: MAIN,
    ready: '.nb-empty'
  },
  {
    id: 'add-to-notebook',
    page: 'panel.html?window=log',
    size: MAIN,
    ready: '.line',
    actions: [
      {
        run: `const line = [...document.querySelectorAll('.line')].find((l) => (l.dataset.lineText ?? '').includes('ダル'));
              const text = line.querySelector('.line-text') ?? line;
              const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
              const node = walker.nextNode();
              const range = document.createRange();
              const at = node.textContent.indexOf('ダル');
              range.setStart(node, at); range.setEnd(node, at + 2);
              const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);`
      },
      { rightClick: { selector: '.line', text: 'ダル' }, after: 500 },
      { click: { selector: '[role="menuitem"]', text: 'Add to notebook' }, after: 700 }
    ]
  },
  {
    id: 'vndb-import',
    page: 'panel.html?window=log&view=notebook',
    size: [900, 640],
    ready: '.nb-row',
    actions: [{ click: '.nb-vndb-icon', after: 600 }]
  },

  // ------------------------------------------------------------------ settings
  ...[
    ['general', 'General'],
    ['sources', 'Sources'],
    ['ocr', 'OCR & Overlay'],
    ['log', 'Log'],
    ['dictionary', 'Dictionary'],
    ['assist', 'Translation & AI'],
    ['controls', 'Shortcuts & Controls'],
    ['account', 'Account']
  ].map(([tab]) => ({
    id: `settings-${tab}`,
    page: settingsTab(tab),
    size: SETTINGS,
    ready: SETTINGS_READY[tab] ?? '.settings-page-scroll',
    actions: tab === 'account' ? [HIDE_DEV_SERVER] : []
  })),
  {
    id: 'settings-ocr-downloading',
    page: settingsTab('ocr', '&model=downloading'),
    size: SETTINGS,
    ready: '.engine-chooser',
    actions: [{ click: { selector: '.engine-item', text: 'Manga OCR' }, after: 600 }],
    marks: [{ type: 'glow', target: { selector: '.engine-detail' }, radius: 10 }]
  },
  {
    id: 'settings-ocr-overlay',
    page: settingsTab('ocr'),
    size: SETTINGS,
    ready: '#ocr-live-overlay',
    actions: [{ run: `document.querySelector('#ocr-live-overlay').scrollIntoView({ block: 'start' }); document.querySelector('.settings-page-scroll').scrollBy(0, -60)` }]
  },
  {
    id: 'settings-auto-ocr',
    page: settingsTab('ocr'),
    size: SETTINGS,
    ready: '#ocr-adaptive',
    actions: [{ run: `document.querySelector('#ocr-autoscan').scrollIntoView({ block: 'start' }); document.querySelector('.settings-page-scroll').scrollBy(0, -60)` }]
  },
  {
    id: 'settings-dictionary-api',
    page: settingsTab('dictionary', '&popup=custom-api'),
    size: SETTINGS,
    ready: '.settings-page-scroll'
  },
  {
    id: 'settings-anki',
    page: settingsTab('anki', '&popup=custom-api'),
    size: SETTINGS,
    ready: '#anki-enabled'
  },
  {
    id: 'settings-account-signedin',
    page: settingsTab('account', '&account=full'),
    size: SETTINGS,
    ready: '.account-meter',
    actions: [HIDE_DEV_SERVER]
  },
  {
    id: 'settings-account-linking',
    page: settingsTab('account', '&account=linking'),
    size: SETTINGS,
    ready: '.account-code',
    actions: [HIDE_DEV_SERVER],
    marks: [{ type: 'glow', target: { selector: '.account-code', pad: 4 }, radius: 10 }]
  },
  {
    id: 'settings-account-conflicts',
    page: settingsTab('account', '&account=signedin&sync=conflicts'),
    size: SETTINGS,
    ready: '.account-meter',
    actions: [HIDE_DEV_SERVER, { run: `[...document.querySelectorAll('h2, h3')].find((h) => h.textContent.trim() === 'Sync')?.scrollIntoView({ block: 'start' })` }]
  },
  {
    id: 'settings-updates',
    page: settingsTab('general', '&update=available'),
    size: SETTINGS,
    ready: '.settings-page-scroll'
  },
  {
    id: 'settings-steam',
    page: settingsTab('general', '&platform=linux&steam=deck'),
    size: SETTINGS,
    ready: '.settings-page-scroll'
  },
  {
    id: 'explain-settings',
    page: settingsTab('assist'),
    size: SETTINGS,
    ready: '#assist-deepl',
    actions: [{ click: { selector: 'button', text: 'Configure' }, after: 600 }]
  },

  // ------------------------------------------------------------------ other windows
  { id: 'diagnostics', page: 'panel.html?window=diagnostics&capture=window:101', size: [680, 720], ready: '[aria-label="Diagnostics view"]' },
  { id: 'sync-log', page: 'panel.html?window=sync-log&account=signedin', size: [760, 520], ready: '.sync-log-text, [class*="sync-log"]' },
  {
    // A lookup as you see it in the Log: the word selected, the dictionary's pop-up beside it (the
    // Yomitan API pop-up, standing in for any engine's) and the pointer.
    id: 'word-lookup',
    page: 'panel.html?window=log',
    size: MAIN,
    crop: { x: 240, y: 0, width: 660, height: 560 },
    ready: '.line',
    actions: [{ run: SHOW_LOOKUP('世界線'), after: 2500 }],
    marks: [{ type: 'cursor', target: '#k-lookup-word', fx: 0.6, fy: 0.75 }]
  },

  // ------------------------------------------------------------------ welcome guide
  ...[
    ['intro', ''],
    ['permission', '&permission=denied'],
    ['accessibility', ''],
    ['ocr', ''],
    ['engine', ''],
    ['dictionaries', '&ext=ready'],
    ['done', '&ext=ready']
  ].map(([step, extra]) => ({
    id: `welcome-${step}`,
    page: `welcome.html?step=${step}${extra}`,
    size: WELCOME,
    settle: 900
  })),
  { id: 'welcome-steam', page: 'welcome.html?step=steam&platform=linux&steam=deck', size: WELCOME, settle: 900 },

  // ------------------------------------------------------------------ platforms
  {
    id: 'linux-source-menu',
    page: 'panel.html?window=log&platform=linux',
    size: MAIN,
    ready: '.src-card',
    actions: [{ click: sourceAction('Change source'), after: 500 }]
  },
  {
    id: 'game-mode-notice',
    page: 'panel.html?window=log&gamemode=1&fullscreen=1',
    size: MAIN,
    crop: SIDEBAR,
    ready: '.src-notice',
    marks: [{ type: 'glow', target: { selector: '.src-notice', pad: 1 }, radius: 8 }]
  },

  // ------------------------------------------------------------------ the marketing site's demo
  {
    id: 'overlay-demo',
    server: 'site',
    page: '',
    size: [1280, 900],
    ready: '.kd-screen .kd-word',
    settle: 1500,
    actions: [
      // The windows' resize grips are for visitors to the live demo, not for a picture of the overlay.
      { run: HIDE_GRIPS + `document.querySelector('#demo').scrollIntoView()`, after: 800 },
      { doubleClick: { selector: '#demo button', text: 'STEINS' }, after: 2000 }
    ],
    clipTo: '.kd-screen',
    marks: [{ type: 'cursor', target: { selector: '.kd-word', text: '容赦' }, fx: 0.55, fy: 0.75 }],
    radius: 10
  },
  {
    id: 'overlay-demo-deck',
    server: 'site',
    page: '',
    size: [1280, 900],
    ready: '.kd-screen .kd-word',
    actions: [
      { run: `document.querySelector('#demo').scrollIntoView()` },
      { click: { selector: '#demo [role="tab"]', text: 'Handheld' }, after: 1500 }
    ],
    clipTo: '.kd-screen',
    radius: 10
  }
]

/**
 * The social cards, 1200×630: the docs' (site-docs/public/og.png) and the marketing site's
 * (site/public/og.png). `out` is relative to the repository root.
 */
const OG_SHOT = { layout: 'og', page: 'panel.html?window=log', size: MAIN, ready: '.line', pad: 0 }
export const OG = [
  {
    ...OG_SHOT,
    id: 'og',
    out: 'site-docs/public/og.png',
    copy: {
      mark: 'Docs',
      title: 'Read and play in Japanese.',
      lede: 'Install, set up OCR and dictionaries, and read with the overlay, the Log and the Notebook.',
      url: 'docs.kimochiapp.com'
    }
  },
  {
    ...OG_SHOT,
    id: 'og-site',
    out: 'site/public/og.png',
    copy: {
      mark: '',
      title: 'Read and play in Japanese.',
      lede: 'Free and open source for macOS, Windows and Linux. OCR, an overlay, pop-up dictionaries and Anki.',
      url: 'kimochiapp.com'
    }
  }
]

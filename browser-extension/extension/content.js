// Kimochi browser extension: the page script.
//
// Injected when the toolbar button is clicked (background.js). It lets the reader pick a picture
// on the page, asks the worker to read it with Kimochi, and lays the lines Kimochi found over the
// picture, so the browser's own dictionary pop-up (Yomitan, 10ten, …) can look them up.
//
// Nothing about the look lives here. Kimochi sends its overlay stylesheet (ui/overlay-text.css)
// and its settings (highlight colour and strength, card appearance, click-through, grouping,
// Auto OCR), and sends them again whenever they change; the boxes are the overlay's own markup
// (`.ocr-word`, `.ocr-word-text`, `data-lit`, `--ocr-*`), styled by that sheet.
//
// The boxes are in the page's own DOM (not a shadow root): dictionary pop-ups find text under the
// pointer with caretRangeFromPoint, which doesn't look inside shadow roots. The toolbar and the
// picker are in a shadow root, out of the page's styles' reach.
;(() => {
  if (window.__kimochiExtension) return
  window.__kimochiExtension = true

  const Z = 2147483646
  const PROXIMITY = 300
  const MIN_SIZE = 24
  const AUTO_DEBOUNCE_MS = 450
  const POLL_MS = 1500

  /** @type {chrome.runtime.Port|null} */
  let port = null
  let status = 'idle'
  let settings = null
  let css = null
  let active = false
  let picking = false
  let candidate = null
  let target = null
  /** The picture's last reading: lines in fractions of the target's content box. */
  let lines = []
  let region = null
  let scanSeq = 0
  let latestScan = 0
  let reading = false
  let message = ''
  let messageTone = 'neutral'
  let fetchFailed = false
  let shift = false
  /** The layer stays open after Shift is let go while the pointer is on a lit box. */
  let held = false
  let pointer = { x: -1, y: -1 }
  let layoutFrame = 0
  let lastSize = ''
  let watchers = []
  let mutationTimer = 0
  /** The boxes cleared when the picture changed, until the new reading says whether it did. */
  let stashed = null

  // ------------------------------------------------------------------ elements

  const boxLayer = document.createElement('div')
  boxLayer.id = 'kimochi-ext-boxes'
  const sheet = document.createElement('style')
  sheet.id = 'kimochi-ext-style'
  // How the page's layer differs from the overlay window: one fixed layer over the picture, and
  // the click-through gate (the overlay does it natively, `Region::shift`).
  const OWN_CSS = `
@font-face{font-family:"Kimochi Figtree";src:url("${chrome.runtime.getURL('fonts/figtree.woff2')}") format("woff2");font-weight:300 900;font-display:swap;}
#kimochi-ext-boxes{position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;z-index:${Z};pointer-events:none;contain:layout style;}
#kimochi-ext-boxes[hidden]{display:none!important;}
#kimochi-ext-boxes .ocr-word,#kimochi-ext-boxes .ocr-group{box-sizing:border-box;margin:0;padding:0;line-height:1;pointer-events:none;transform-origin:center center;}
#kimochi-ext-boxes[data-open] .ocr-word{pointer-events:auto;}
#kimochi-ext-boxes .ocr-word-text{display:block;white-space:nowrap;font:inherit;letter-spacing:inherit;color:inherit;user-select:text;-webkit-user-select:text;}
#kimochi-ext-boxes .ocr-word.kx-grouped::before,#kimochi-ext-boxes .ocr-word.kx-grouped::after{display:none;}
#kimochi-ext-boxes[data-hide]{visibility:hidden!important;}`

  // The toolbar, the session menu and the picker, in Kimochi's own look (DESIGN.md): light or
  // dark as Kimochi is set (`settings.appearance`), Figtree, its indigo.
  const ICONS = {
    book: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    chevrons: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
    read: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
    pick: '<circle cx="12" cy="12" r="10"/><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4"/>',
    open: '<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/>',
    close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  }
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`
  const LOGO_URL = chrome.runtime.getURL('icons/logo.svg')

  const uiHost = document.createElement('div')
  uiHost.id = 'kimochi-ext-ui'
  uiHost.style.cssText = `position:fixed;inset:0;z-index:${Z + 1};pointer-events:none;`
  const shadow = uiHost.attachShadow({ mode: 'closed' })
  shadow.innerHTML = `
<style>
  :host{all:initial;--track:#0009321f;
    --bg:#ffffff;--bar:#f9f9fb;--ink:#1c2024;--ink2:#60646c;--faint:#80838d;--line:#00002d17;--hover:#0000330f;--press:#00002d17;
    --accent:#3e63dd;--accent-text:#3a5bc7;--accent-soft:#0047f112;--ok:#30a46c;--danger:#e5484d;--warn:#ffb224;
    --shadow:0 1px 2px rgba(15,17,26,.08),0 12px 32px -8px rgba(15,17,26,.28);--ring:#8da4ef}
  :host([data-theme=dark]){--bg:#18191b;--bar:#111113;--ink:#edeef0;--ink2:#b0b4ba;--faint:#777b84;--line:#d3edf81d;--hover:#ffffff12;--press:#ffffff1c;
    --accent-text:#9eb1ff;--accent-soft:#3e63dd33;--track:#ffffff2e;--shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px -8px rgba(0,0,0,.7);--ring:#435db1}
  *{box-sizing:border-box}
  .ui{font-family:"Kimochi Figtree",Figtree,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;line-height:20px;font-weight:430;color:var(--ink);-webkit-font-smoothing:antialiased}
  .pick{position:fixed;display:none;border:2px solid var(--accent);background:rgba(62,99,221,.12);border-radius:6px;pointer-events:none;transition:all 90ms ease-out}
  .pick[data-on]{display:block}
  .panel{background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}
  .banner{position:fixed;left:50%;top:20px;transform:translateX(-50%);padding:10px 16px;display:none;gap:14px;align-items:center;pointer-events:auto;white-space:nowrap}
  .banner[data-on]{display:flex}
  .banner strong{font-weight:620}
  .banner .hint{color:var(--ink2);font-size:12px}
  kbd{font:600 11px/1 inherit;font-family:inherit;padding:3px 6px;border-radius:5px;background:var(--hover);border:1px solid var(--line);color:var(--ink2)}
  .bar{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);display:none;align-items:center;gap:6px;padding:8px;pointer-events:auto;max-width:calc(100vw - 32px)}
  .bar[data-on]{display:flex}
  .logo{position:relative;flex:none;width:32px;height:32px;margin:0 2px 0 4px}
  .logo img{width:32px;height:32px;display:block}
  .pip{position:absolute;right:-3px;bottom:-3px;width:12px;height:12px;border-radius:50%;background:var(--faint);box-shadow:0 0 0 2.5px var(--bg)}
  .pip[data-tone=ok]{background:var(--ok)}
  .pip[data-tone=danger]{background:var(--danger)}
  .pip[data-tone=busy]{background:var(--warn);animation:pulse 1.1s ease-in-out infinite}
  @keyframes pulse{50%{opacity:.4}}
  .msg{padding:0 8px 0 6px;color:var(--ink2);font-weight:520;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;max-width:260px;font-variant-numeric:tabular-nums}
  .msg[data-tone=danger]{color:var(--danger)}
  .sep{width:1px;height:20px;background:var(--line);flex:none;margin:0 4px}
  button{all:unset;box-sizing:border-box;cursor:pointer;position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;color:var(--ink);border-radius:8px;font:inherit;font-weight:520}
  button:hover{background:var(--hover)}
  button:active{background:var(--press)}
  button:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
  button:disabled{opacity:.38;cursor:default;background:none}
  .sq{width:32px;height:32px}
  .session{height:32px;gap:8px;padding:0 8px 0 9px;max-width:240px}
  .session .name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .session .name[data-new]{color:var(--ink2);font-style:italic}
  .session svg.chev{width:14px;height:14px;color:var(--faint)}
  svg{width:16px;height:16px;flex:none;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
  .toggle{height:32px;gap:8px;padding:0 9px;color:var(--ink2)}
  .toggle[aria-checked=true]{color:var(--ink)}
  .track{position:relative;width:28px;height:16px;border-radius:999px;background:var(--track);transition:background 140ms ease-out;flex:none}
  .track::after{content:'';position:absolute;left:2px;top:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform 140ms ease-out}
  .toggle[aria-checked=true] .track{background:var(--accent)}
  .toggle[aria-checked=true] .track::after{transform:translateX(12px)}
  .eicon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;border-radius:5px;overflow:hidden}
  .eicon img{width:100%;height:100%;object-fit:contain;display:block}
  .eicon.tile{background:var(--hover);box-shadow:inset 0 0 0 1px var(--line);color:var(--ink2);font-size:10px;font-weight:620;line-height:1}
  .eicon.tile img,.eicon.tile svg{width:72%;height:72%}
  .eicon.big{width:24px;height:24px;border-radius:6px}
  .eicon.big.tile{font-size:12px}
  .item.tall{height:auto;min-height:44px;padding:6px 8px;align-items:center}
  .item .text{flex:1;display:flex;flex-direction:column;min-width:0}
  .item .text .label{flex:none}
  .item .desc{font-size:12px;line-height:16px;color:var(--ink2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .item .runs{color:var(--faint);display:inline-flex}
  .item .runs svg{width:14px;height:14px}
  /* Tooltips: styled, above their button, after a short wait. */
  [data-tip]::after{content:attr(data-tip);position:absolute;left:50%;bottom:calc(100% + 10px);transform:translate(-50%,4px);padding:5px 9px;border-radius:7px;background:var(--ink);color:var(--bg);font-size:12px;font-weight:520;line-height:16px;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity 120ms ease-out,transform 120ms ease-out;box-shadow:0 4px 14px -4px rgba(0,0,0,.4);z-index:2}
  [data-tip]:hover::after,[data-tip]:focus-visible::after{opacity:1;transform:translate(-50%,0);transition-delay:350ms}
  [data-tip][data-menu-open]::after{display:none}
  .menu{position:fixed;display:none;width:280px;padding:6px;pointer-events:auto;max-height:min(420px,calc(100vh - 120px));overflow:auto}
  .menu[data-on]{display:block}
  .menu .head{padding:6px 8px 4px;font-size:11px;font-weight:620;letter-spacing:.02em;color:var(--faint);text-transform:uppercase}
  .item{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;height:32px;padding:0 8px;border-radius:7px;cursor:pointer;color:var(--ink);font-weight:450}
  .item:hover,.item:focus-visible{background:var(--hover);outline:none}
  .item .label{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .item .tick{width:16px;height:16px;color:var(--accent-text);visibility:hidden}
  .item[aria-checked=true] .tick{visibility:visible}
  .item .sub{color:var(--faint);font-size:11px}
  .menu hr{border:0;border-top:1px solid var(--line);margin:6px 2px}
  .menu form{display:flex;gap:6px;padding:4px 4px 2px}
  .menu input{all:unset;box-sizing:border-box;flex:1;height:30px;padding:0 9px;border-radius:7px;border:1px solid var(--line);background:var(--bar);color:var(--ink);font:inherit;min-width:0}
  .menu input:focus{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
  .menu form button{height:30px;padding:0 12px;background:var(--accent);color:#fff;border-radius:7px}
  .menu form button:hover{background:#3358d4}
  .empty{padding:8px;color:var(--ink2)}
  @media (prefers-reduced-motion: reduce){.pick,[data-tip]::after{transition:none}.pip[data-tone=busy]{animation:none}}
</style>
<div class="ui">
  <div class="pick"></div>
  <div class="banner panel" role="status"><strong>Click a picture for Kimochi to read</strong><span class="hint"><kbd>↑</kbd> bigger area</span><span class="hint"><kbd>Esc</kbd> cancel</span></div>
  <div class="bar panel" role="toolbar" aria-label="Kimochi">
    <span class="logo"><img alt="Kimochi"><span class="pip"></span></span>
    <span class="msg" role="status"></span>
    <button class="toggle" role="switch" data-act="auto" aria-checked="true">Auto<span class="track"></span></button>
    <span class="sep"></span>
    <button class="session engine" data-act="engine" aria-haspopup="menu" data-tip="Choose the OCR model" hidden><span class="eicon"></span><span class="name"></span><svg class="chev" viewBox="0 0 24 24">${ICONS.chevrons}</svg></button>
    <button class="session" data-act="session" aria-haspopup="menu" data-tip="Choose the session these lines go to">${icon('book')}<span class="name"></span><svg class="chev" viewBox="0 0 24 24">${ICONS.chevrons}</svg></button>
    <span class="sep"></span>
    <button class="sq" data-act="read" data-tip="Read the picture again" aria-label="Read the picture again">${icon('read')}</button>
    <button class="sq" data-act="pick" data-tip="Pick another picture" aria-label="Pick another picture">${icon('pick')}</button>
    <button class="sq" data-act="open" data-tip="Open Kimochi" aria-label="Open Kimochi">${icon('open')}</button>
    <button class="sq" data-act="stop" data-tip="Stop reading this page" aria-label="Stop reading this page">${icon('close')}</button>
  </div>
  <div class="menu panel" role="menu" aria-label="Sessions"></div>
</div>`
  shadow.querySelector('.logo img').src = LOGO_URL
  const pickBox = shadow.querySelector('.pick')
  const banner = shadow.querySelector('.banner')
  const hud = shadow.querySelector('.bar')
  const hudPip = shadow.querySelector('.pip')
  const hudMsg = shadow.querySelector('.msg')
  const autoToggle = shadow.querySelector('.toggle')
  const engineButton = shadow.querySelector('.engine')
  const menu = shadow.querySelector('.menu')
  const sessionName = shadow.querySelector('[data-act=session] .name')
  const buttons = Object.fromEntries([...shadow.querySelectorAll('button[data-act]')].map((b) => [b.dataset.act, b]))

  hud.addEventListener('click', (event) => {
    const action = event.target.closest?.('button')?.dataset.act
    if (action === 'open') openKimochi()
    else if (action === 'read') scan('rescan')
    else if (action === 'pick') startPicking()
    else if (action === 'stop') stop()
    else if (action === 'session') toggleMenu('list')
    else if (action === 'engine') toggleMenu('engines')
    else if (action === 'auto') setAuto(!autoMode)
  })

  // ------------------------------------------------------------------ sessions

  /** Kimochi's sessions, kept current by the Log (`{sessions: [{id, name}], active}`). */
  let sessionList = { sessions: [], active: null }
  /** This tab's session: chosen, remembered for the page, or made at its first reading. Null until known. */
  let session = null
  let pageAsked = false
  let menuMode = 'list'

  const sessionById = (id) => sessionList.sessions.find((s) => s.id === id)
  /** Requests this tab made: answers come to every tab, and each keeps only its own. */
  const asked = new Set()
  const nonce = () => {
    const id = crypto.randomUUID()
    asked.add(id)
    return id
  }

  function askPage() {
    if (pageAsked || status !== 'connected') return
    pageAsked = true
    post({ type: 'page', id: nonce(), url: location.href, title: document.title })
  }

  function chooseSession(id) {
    session = id
    post({ type: 'assign', url: location.href, title: document.title, session: id })
    rememberTarget()
    closeMenu()
    render()
  }

  /** The button a menu opens from: the model menu's, or the session menu's (its list and forms). */
  const menuAnchor = (mode = menuMode) => (mode === 'engines' ? engineButton : buttons.session)

  function toggleMenu(mode) {
    const open = menu.hasAttribute('data-on')
    const same = open && menuAnchor() === menuAnchor(mode)
    if (open) closeMenu()
    if (!same) openMenu(mode)
  }

  function openMenu(mode) {
    closeMenu()
    menuMode = mode
    drawMenu()
    menu.setAttribute('data-on', '')
    menu.setAttribute('aria-label', mode === 'engines' ? 'OCR model' : 'Sessions')
    menuAnchor().setAttribute('data-menu-open', '')
    menuAnchor().setAttribute('aria-expanded', 'true')
    placeMenu()
    const focus = menu.querySelector('input') ?? menu.querySelector('.item[aria-checked=true]') ?? menu.querySelector('.item')
    focus?.focus()
    // Renaming starts with the old name selected, to type over.
    if (focus instanceof HTMLInputElement) focus.select()
  }

  function closeMenu() {
    menu.removeAttribute('data-on')
    for (const button of [buttons.session, engineButton]) {
      button.removeAttribute('data-menu-open')
      button.setAttribute('aria-expanded', 'false')
    }
  }

  function placeMenu() {
    const anchor = menuAnchor().getBoundingClientRect()
    const width = menu.offsetWidth
    const left = Math.min(Math.max(12, anchor.left + anchor.width / 2 - width / 2), innerWidth - width - 12)
    menu.style.left = `${left}px`
    menu.style.bottom = `${innerHeight - anchor.top + 14}px`
  }

  function drawMenu() {
    if (menuMode === 'engines') return drawEngines()
    const current = sessionById(session)
    if (menuMode === 'new' || menuMode === 'rename') {
      const renaming = menuMode === 'rename' && current
      menu.innerHTML = `<div class="head">${renaming ? 'Rename session' : 'New session'}</div>
        <form><input name="name" autocomplete="off" spellcheck="false" placeholder="${renaming ? '' : 'Name (leave empty for today’s date)'}"><button type="submit">${renaming ? 'Rename' : 'Create'}</button></form>`
      const input = menu.querySelector('input')
      if (renaming) input.value = current.name
      menu.querySelector('form').addEventListener('submit', (event) => {
        event.preventDefault()
        const name = input.value.trim()
        if (renaming) {
          if (name) post({ type: 'renameSession', session: current.id, name })
          closeMenu()
        } else {
          post({ type: 'createSession', id: nonce(), name, url: location.href, title: document.title })
          closeMenu()
          setMessage('Making a new session…', 'busy')
          render()
        }
      })
      return
    }
    const rows = sessionList.sessions
      .map(
        (s) =>
          `<button class="item" role="menuitemradio" aria-checked="${s.id === session}" data-session="${s.id}"><svg class="tick" viewBox="0 0 24 24">${ICONS.check}</svg><span class="label"></span>${s.id === sessionList.active ? '<span class="sub">open in Kimochi</span>' : ''}</button>`
      )
      .join('')
    menu.innerHTML = `<div class="head">Send lines to</div>${rows || '<div class="empty">No sessions yet</div>'}<hr>
      <button class="item" role="menuitem" data-op="new">${icon('plus')}<span class="label">New session…</span></button>
      ${current ? `<button class="item" role="menuitem" data-op="rename">${icon('pencil')}<span class="label">Rename “${''}”…</span></button>` : ''}`
    // Names are set as text, never as markup.
    menu.querySelectorAll('[data-session]').forEach((row) => {
      row.querySelector('.label').textContent = sessionById(row.dataset.session)?.name ?? ''
    })
    const rename = menu.querySelector('[data-op=rename] .label')
    if (rename && current) rename.textContent = `Rename “${current.name}”…`
  }

  menu.addEventListener('click', (event) => {
    const row = event.target.closest?.('.item')
    if (!row) return
    if (row.dataset.engine) {
      // Chosen in Kimochi, as its sidebar chooses (a model to download asks there first).
      post({ type: 'setEngine', id: row.dataset.engine })
      closeMenu()
    } else if (row.dataset.session) chooseSession(row.dataset.session)
    else if (row.dataset.op) openMenu(row.dataset.op)
  })
  menu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      closeMenu()
      buttons.session.focus()
    } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && (menuMode === 'list' || menuMode === 'engines')) {
      event.preventDefault()
      const items = [...menu.querySelectorAll('.item')]
      const at = items.indexOf(shadow.activeElement)
      items[(at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }
  })
  // A click anywhere else closes the menu.
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (menu.hasAttribute('data-on') && !event.composedPath().includes(uiHost)) closeMenu()
    },
    true
  )
  shadow.addEventListener('pointerdown', (event) => {
    if (menu.hasAttribute('data-on') && !event.composedPath().some((el) => el === menu || el === buttons.session || el === engineButton)) closeMenu()
  })

  // ------------------------------------------------------------------ the OCR model

  /** Kimochi's engines as its sidebar lists them: `{engines: [{id, name, tagline, runs, icon}], selected}`. */
  let engineList = null

  /** An engine's picture, as the app draws it: its logo, or a glyph or monogram in a tile. */
  function engineIcon(engine, big = false) {
    const box = document.createElement('span')
    box.className = `eicon${big ? ' big' : ''}`
    const icon = engine?.icon ?? {}
    if (icon.image) {
      if (icon.tile) box.classList.add('tile')
      const img = document.createElement('img')
      img.alt = ''
      img.src = icon.image
      box.append(img)
    } else if (icon.svg) {
      box.classList.add('tile')
      // Markup Kimochi drew (its own icon set), never page content.
      box.innerHTML = icon.svg
    } else {
      box.classList.add('tile')
      box.textContent = icon.monogram ?? engine?.name?.slice(0, 1) ?? ''
      if (icon.lang) box.lang = icon.lang
    }
    return box
  }

  function drawEngines() {
    menu.replaceChildren()
    const head = document.createElement('div')
    head.className = 'head'
    head.textContent = 'OCR model'
    menu.append(head)
    for (const engine of engineList?.engines ?? []) {
      const row = document.createElement('button')
      row.className = 'item tall'
      row.setAttribute('role', 'menuitemradio')
      row.setAttribute('aria-checked', String(engine.id === engineList.selected))
      row.dataset.engine = engine.id
      row.innerHTML = `<svg class="tick" viewBox="0 0 24 24">${ICONS.check}</svg>`
      const text = document.createElement('span')
      text.className = 'text'
      const label = document.createElement('span')
      label.className = 'label'
      label.textContent = engine.name
      const desc = document.createElement('span')
      desc.className = 'desc'
      desc.textContent = engine.tagline ?? ''
      text.append(label, desc)
      const runs = document.createElement('span')
      runs.className = 'runs'
      runs.title = engine.runs === 'local' ? 'Runs on this computer' : 'Runs online'
      runs.innerHTML = icon(engine.runs === 'local' ? 'monitor' : 'cloud')
      row.append(engineIcon(engine, true), text, runs)
      menu.append(row)
    }
  }

  function renderEngine() {
    const current = engineList?.engines?.find((e) => e.id === engineList.selected)
    engineButton.hidden = !engineList?.engines?.length
    if (!current) return
    engineButton.querySelector('.eicon').replaceWith(engineIcon(current))
    engineButton.querySelector('.name').textContent = current.name
    engineButton.setAttribute('aria-label', `OCR model: ${current.name}`)
  }

  // ------------------------------------------------------------------ Auto

  /**
   * Auto (the toolbar's switch, on unless turned off; remembered by the browser): the picture is
   * read again whenever it changes, and after a full page load the picture in the same place on
   * a page like it is found and read (a gallery's next image, a reader's next page).
   */
  let autoMode = true
  chrome.storage.local.get({ auto: true }).then(
    (stored) => {
      autoMode = stored.auto !== false
      syncWatch()
      render()
    },
    () => undefined
  )

  function setAuto(on) {
    autoMode = on
    void chrome.storage.local.set({ auto: on }).catch(() => undefined)
    syncWatch()
    rememberTarget()
    render()
    if (on && target && lines.length === 0 && !reading) scan('auto')
  }

  function mount() {
    if (!sheet.isConnected) (document.head || document.documentElement).append(sheet)
    if (!boxLayer.isConnected) document.documentElement.append(boxLayer)
    if (!uiHost.isConnected) document.documentElement.append(uiHost)
    applyLook()
  }

  // ------------------------------------------------------------------ connection

  function connectPort() {
    port = chrome.runtime.connect({ name: 'kimochi' })
    port.onMessage.addListener(onMessage)
    port.onDisconnect.addListener(() => {
      port = null
      // The worker was restarted (an extension update, or it was stopped): reconnect while on.
      if (active) setTimeout(() => active && !port && connectPort(), 500)
    })
  }

  function post(message) {
    if (!port) connectPort()
    try {
      port.postMessage(message)
    } catch {
      port = null
      connectPort()
      port.postMessage(message)
    }
  }

  function onMessage(msg) {
    switch (msg.type) {
      case 'status':
        status = msg.status
        if (status === 'connected') askPage()
        else pageAsked = false
        // Picked (or found after a page load) before Kimochi answered: read it now.
        if (status === 'connected' && target && !lines.length && !reading) {
          reading = true
          setMessage('', 'busy')
          scan(lastReason)
        }
        render()
        break
      case 'sessions':
        sessionList = msg.sessions ?? { sessions: [], active: null }
        // A session deleted in Kimochi: back to the page's own (remembered, or new).
        if (session && !sessionById(session)) session = null
        if (menu.hasAttribute('data-on') && menuMode === 'list') drawMenu()
        render()
        break
      case 'engines':
        engineList = msg.engines
        if (menu.hasAttribute('data-on') && menuMode === 'engines') drawEngines()
        renderEngine()
        break
      case 'page':
        if (!asked.delete(msg.id)) break
        if (msg.session && !session) session = msg.session
        render()
        break
      case 'sessionCreated':
        if (!asked.delete(msg.id)) break
        if (msg.error) setMessage(msg.error, 'danger')
        else {
          session = msg.session
          setMessage('', 'ok')
        }
        render()
        break
      case 'settings': {
        settings = msg.settings
        if (msg.css) css = msg.css
        applyLook()
        render()
        break
      }
      case 'ended':
        if (active) {
          clearBoxes()
          setMessage('Kimochi switched to another source', 'warn')
          render()
        }
        break
      case 'rescan':
        if (target) scan('rescan')
        break
      case 'captured':
        boxLayer.removeAttribute('data-hide')
        uiHost.style.visibility = ''
        break
      case 'reading':
        if (msg.id === latestScan) {
          reading = true
          render()
        }
        break
      case 'unchanged':
        if (msg.id === latestScan) {
          reading = false
          // The same pixels after all: the boxes cleared for the reading were right.
          if (stashed && !lines.length) {
            lines = stashed.lines
            region = stashed.region
            lastSize = ''
            layout()
          }
          stashed = null
          render()
        }
        break
      case 'result':
        if (msg.id === latestScan) {
          if (msg.result?.session || msg.session) session = msg.result?.session ?? msg.session
          applyResult(msg)
          rememberTarget()
        }
        break
      case 'error':
        if (msg.id !== latestScan) break
        reading = false
        stashed = null
        if (msg.message === 'fetch-failed' && !fetchFailed) {
          // The picture's own bytes couldn't be had: read it off the screen instead.
          fetchFailed = true
          scan(lastReason)
          break
        }
        setMessage(msg.message, 'danger')
        render()
        break
    }
  }

  function openKimochi() {
    if (status === 'connected') {
      post({ type: 'show' })
      return
    }
    // The browser asks whether to open Kimochi; the worker reconnects as soon as it is up.
    const link = document.createElement('a')
    link.href = 'kimochi://browser'
    link.style.display = 'none'
    document.documentElement.append(link)
    link.click()
    link.remove()
    setMessage('Opening Kimochi…', 'busy')
    render()
    post({ type: 'connect' })
  }

  // ------------------------------------------------------------------ the look (from Kimochi)

  function applyLook() {
    sheet.textContent = (css ?? '') + OWN_CSS
    const style = settings?.overlayStyle ?? {}
    const color = /^#[0-9a-f]{6}$/i.test(style.color ?? '') ? style.color : '#3e63dd'
    const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)).join(', ')
    const opacity = Number.isFinite(style.opacity) ? Math.min(100, Math.max(0, style.opacity)) : 40
    boxLayer.style.setProperty('--ocr-hl-rgb', rgb)
    boxLayer.style.setProperty('--ocr-hl-strength', String(Math.round((opacity / 40) * 1000) / 1000))
    boxLayer.dataset.ocrTheme = theme(style.appearance)
    // The toolbar is a Kimochi window: light or dark as Kimochi is.
    const app = settings?.appearance
    const dark = app === 'dark' || (app !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches)
    uiHost.setAttribute('data-theme', dark ? 'dark' : 'light')
  }

  /** The cards' appearance, as the overlay resolves it (`resolveOverlayCardAppearance`). */
  function theme(appearance) {
    if (appearance === 'light' || appearance === 'dark' || appearance === 'blend') return appearance
    const app = settings?.appearance
    if (app === 'light' || app === 'dark') return app
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyLook)

  // ------------------------------------------------------------------ picking

  function startPicking() {
    activate()
    picking = true
    candidate = null
    pickBox.removeAttribute('data-on')
    banner.setAttribute('data-on', '')
    boxLayer.setAttribute('hidden', '')
    render()
  }

  function stopPicking() {
    picking = false
    candidate = null
    pickBox.removeAttribute('data-on')
    banner.removeAttribute('data-on')
    boxLayer.removeAttribute('hidden')
  }

  const isOurs = (el) => el === uiHost || el === boxLayer || boxLayer.contains(el)
  const sized = (el) => {
    const r = el.getBoundingClientRect()
    return r.width >= MIN_SIZE && r.height >= MIN_SIZE
  }
  const isPicture = (el) =>
    el instanceof HTMLImageElement || el instanceof HTMLCanvasElement || el instanceof HTMLVideoElement || el instanceof SVGSVGElement
  const hasBackground = (el) => {
    const image = getComputedStyle(el).backgroundImage
    return image && image !== 'none' && image.includes('url(')
  }

  /** The picture under the pointer: an image, canvas or video, else an element with a background picture, else the smallest sizable element. */
  function pictureAt(x, y) {
    const stack = document.elementsFromPoint(x, y).filter((el) => !isOurs(el))
    return (
      stack.find((el) => isPicture(el) && sized(el)) ??
      stack.find((el) => hasBackground(el) && sized(el) && el !== document.body && el !== document.documentElement) ??
      stack.find((el) => sized(el) && el !== document.body && el !== document.documentElement) ??
      null
    )
  }

  function showCandidate() {
    if (!candidate) {
      pickBox.removeAttribute('data-on')
      return
    }
    const r = candidate.getBoundingClientRect()
    Object.assign(pickBox.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` })
    pickBox.setAttribute('data-on', '')
  }

  const swallow = (event) => {
    if (!picking) return
    if (event.composedPath?.().includes(uiHost)) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'contextmenu', 'dblclick', 'auxclick']) {
    window.addEventListener(type, swallow, true)
  }
  window.addEventListener(
    'click',
    (event) => {
      if (!picking || event.composedPath?.().includes(uiHost)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const picked = candidate ?? pictureAt(event.clientX, event.clientY)
      stopPicking()
      if (picked) choose(picked)
      else render()
    },
    true
  )

  // ------------------------------------------------------------------ the pointer and Shift

  window.addEventListener(
    'pointermove',
    (event) => {
      pointer = { x: event.clientX, y: event.clientY }
      if (picking) {
        const next = pictureAt(event.clientX, event.clientY)
        if (next !== candidate) {
          candidate = next
          showCandidate()
        }
        return
      }
      if (lines.length) scheduleProximity()
    },
    { capture: true, passive: true }
  )

  window.addEventListener(
    'keydown',
    (event) => {
      if (picking) {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopImmediatePropagation()
          stopPicking()
          if (!target) stop()
          else render()
        } else if (event.key === 'ArrowUp' && candidate?.parentElement && candidate.parentElement !== document.documentElement) {
          event.preventDefault()
          candidate = candidate.parentElement
          showCandidate()
        }
        return
      }
      if (event.key === 'Shift' && !shift) {
        shift = true
        gate()
      }
    },
    true
  )
  window.addEventListener(
    'keyup',
    (event) => {
      if (event.key !== 'Shift') return
      shift = false
      // Once lit, a box stays usable while the pointer is on it, as in the overlay.
      held = Boolean(boxUnderPointer()?.hasAttribute('data-lit'))
      gate()
    },
    true
  )
  window.addEventListener('blur', () => {
    shift = false
    held = false
    gate()
  })

  const clickThrough = () => settings?.clickThrough !== false

  /** Boxes take the pointer: always without click-through; with it, while Shift is held. */
  function gate() {
    const open = !clickThrough() || shift || held
    boxLayer.toggleAttribute('data-open', open)
    if (open) {
      // The box under a resting pointer lights now, not on the next move.
      const box = boxUnderPointer()
      if (box) light(box)
    } else unlightAll()
  }

  function boxUnderPointer() {
    if (pointer.x < 0) return null
    for (const box of boxLayer.querySelectorAll('.ocr-word')) {
      const r = box.getBoundingClientRect()
      if (pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom) return box
    }
    return null
  }

  function light(box) {
    const group = box.dataset.group
    for (const other of boxLayer.querySelectorAll('[data-lit]')) {
      if (other.dataset.group !== group) other.removeAttribute('data-lit')
    }
    for (const el of boxLayer.querySelectorAll(`[data-group="${CSS.escape(group)}"]`)) el.setAttribute('data-lit', '')
  }

  function unlightAll() {
    for (const el of boxLayer.querySelectorAll('[data-lit]')) el.removeAttribute('data-lit')
  }

  boxLayer.addEventListener('pointerover', (event) => {
    const box = event.target.closest?.('.ocr-word')
    if (box && boxLayer.hasAttribute('data-open')) light(box)
  })
  boxLayer.addEventListener('pointerout', (event) => {
    const box = event.target.closest?.('.ocr-word')
    if (!box) return
    const into = event.relatedTarget?.closest?.('.ocr-word')
    if (into && into.dataset.group === box.dataset.group) return
    for (const el of boxLayer.querySelectorAll(`[data-group="${CSS.escape(box.dataset.group)}"]`)) el.removeAttribute('data-lit')
    if (held && !shift) {
      held = false
      gate()
    }
  })

  let proximityFrame = 0
  function scheduleProximity() {
    if (proximityFrame) return
    proximityFrame = requestAnimationFrame(() => {
      proximityFrame = 0
      for (const el of boxLayer.querySelectorAll('.ocr-word:not(.kx-grouped), .ocr-group')) {
        const r = el.getBoundingClientRect()
        const near = Math.max(0, 1 - Math.hypot(pointer.x - (r.left + r.width / 2), pointer.y - (r.top + r.height / 2)) / PROXIMITY)
        el.style.setProperty('--ocr-near', String(Math.round(near * 100) / 100))
      }
    })
  }

  // ------------------------------------------------------------------ reading

  function choose(element, reason = 'select') {
    if (target !== element) {
      unwatch()
      target = element
      fetchFailed = false
      clearBoxes()
    }
    syncWatch()
    rememberTarget()
    scan(reason)
  }

  // ------------------------------------------------------------------ the same picture on the next page

  /** Where the picture sits in the page, to find its like after a full page load (`findLike`). */
  function signatureOf(el) {
    const r = el.getBoundingClientRect()
    return {
      origin: location.origin,
      href: location.href,
      path: cssPath(el),
      tag: el.tagName.toLowerCase(),
      classes: stableClasses(el),
      parentClasses: el.parentElement ? stableClasses(el.parentElement) : [],
      rect: { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height },
      session,
      auto: autoMode,
    }
  }

  /** Class names that say what a thing is, not which one it is (no numbers: `page-12`, hashes). */
  const stableClasses = (el) => [...el.classList].filter((c) => !/\d/.test(c)).slice(0, 6)

  /** A CSS path from the nearest stable id (or the body) down to the element. */
  function cssPath(el) {
    const parts = []
    for (let node = el; node && node.nodeType === 1 && node !== document.body && node !== document.documentElement; node = node.parentElement) {
      if (node.id && !/\d/.test(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`)
        break
      }
      let part = node.tagName.toLowerCase()
      const classes = stableClasses(node).slice(0, 3)
      if (classes.length) part += classes.map((c) => `.${CSS.escape(c)}`).join('')
      const same = node.parentElement ? [...node.parentElement.children].filter((c) => c.tagName === node.tagName) : []
      if (same.length > 1) part += `:nth-of-type(${[...node.parentElement.children].filter((c) => c.tagName === node.tagName).indexOf(node) + 1})`
      parts.unshift(part)
    }
    return parts.join(' > ')
  }

  /**
   * The picture on this page most like the remembered one: at the same path if it is about the
   * same size, else the element of the same kind closest to where it was and of a similar size,
   * its classes a tiebreak. None when nothing is close enough.
   */
  function findLike(signature) {
    const ready = (el) => !(el instanceof HTMLImageElement) || (el.complete && el.naturalWidth > 0)
    const sizeLike = (r) => {
      const { w, h } = signature.rect
      if (!r.width || !r.height || !w || !h) return 0
      return Math.min(r.width / w, w / r.width) * Math.min(r.height / h, h / r.height)
    }
    try {
      const at = document.querySelector(signature.path)
      if (at && !isOurs(at) && sizeLike(at.getBoundingClientRect()) > 0.3) return ready(at) ? at : 'wait'
    } catch {
      // A path this page can't parse.
    }
    const want = signature.rect
    const reach = Math.max(200, 0.6 * Math.max(want.w, want.h))
    let best = null
    let bestScore = -Infinity
    for (const el of document.querySelectorAll(signature.tag)) {
      if (isOurs(el)) continue
      const r = el.getBoundingClientRect()
      const like = sizeLike(r)
      if (like < 0.3) continue
      const distance = Math.hypot(r.left + scrollX + r.width / 2 - (want.x + want.w / 2), r.top + scrollY + r.height / 2 - (want.y + want.h / 2))
      if (distance > reach) continue
      const shared = (a, b) => (a.length || b.length ? a.filter((c) => b.includes(c)).length / new Set([...a, ...b]).size : 0)
      const score = like * 2 + shared(stableClasses(el), signature.classes) + shared(el.parentElement ? stableClasses(el.parentElement) : [], signature.parentClasses) - distance / reach
      if (score > bestScore) {
        bestScore = score
        best = el
      }
    }
    if (!best) return null
    return ready(best) ? best : 'wait'
  }

  let lastSignature = null
  function rememberTarget() {
    if (!target?.isConnected) return
    lastSignature = signatureOf(target)
    post({ type: 'remember-target', signature: lastSignature })
  }

  /** A full page load in a tab that was reading (background.js): find the picture's like and read it. */
  function resume(signature) {
    activate()
    lastSignature = signature
    if (signature.session) session = signature.session
    setMessage('Looking for the picture…', 'busy')
    render()
    lookFor(signature)
  }

  /** Each search for the picture; a newer one (another page change) ends the one before. */
  let lookToken = 0

  /** Find the picture like `signature` on the page as it is now, waiting while the page builds. */
  function lookFor(signature) {
    const token = ++lookToken
    const started = Date.now()
    const look = () => {
      if (!active || token !== lookToken) return
      const found = findLike(signature)
      if (found && found !== 'wait') {
        // Straight to reading: nothing from the last page is shown meanwhile.
        reading = true
        setMessage('', 'busy')
        choose(found, 'auto')
        return
      }
      // Pages build themselves and pictures load late: keep looking a little while.
      if (Date.now() - started < 12_000) setTimeout(look, 400)
      else {
        setMessage('No picture like the last one here: pick one', 'neutral')
        render()
      }
    }
    look()
  }

  let lastReason = 'select'

  // ------------------------------------------------------------------ a page change without a page load

  /**
   * Most galleries and readers change pages without loading a new document: they swap the content
   * and the URL. To the reader that is a new page, so it is treated as one: the boxes go the
   * moment the navigation starts (a full page load too, which keeps the old page on screen until
   * the new one paints), the toolbar says a reading is coming, and once the new content is in the
   * picture in the same place on it is found again and read.
   */
  let lastHref = location.href
  let navTimer = 0

  function leavingPage() {
    if (!active || (!target && !lastSignature)) return
    clearTimeout(mutationTimer)
    stashed = null
    clearBoxes()
    lastSize = ''
    if (autoOn()) {
      reading = true
      setMessage('', 'busy')
    } else setMessage('The page changed: read the picture again', 'neutral')
    render()
  }

  function pageChanged() {
    if (location.href === lastHref) return
    lastHref = location.href
    if (!active || (!target && !lastSignature)) return
    leavingPage()
    if (!autoOn()) return
    const signature = lastSignature ?? (target?.isConnected ? signatureOf(target) : null)
    if (!signature) return
    clearTimeout(navTimer)
    // Its own content is put in place just after the URL changes; give it a moment.
    navTimer = setTimeout(() => {
      target = null
      unwatch()
      lookFor(signature)
    }, 250)
  }

  // The Navigation API (Chrome) says when a navigation starts and when one in the page is done.
  window.navigation?.addEventListener('navigate', () => leavingPage())
  window.navigation?.addEventListener('navigatesuccess', () => pageChanged())
  window.addEventListener('popstate', () => pageChanged())
  // Leaving for another document: nothing stale stays up while the old page is still shown.
  window.addEventListener('pagehide', () => {
    boxLayer.setAttribute('hidden', '')
  })
  // Back from the back/forward cache: the page as it was, read again in case it changed.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !active) return
    boxLayer.removeAttribute('hidden')
    lastSize = ''
    layout()
    if (autoOn() && target) scan('auto')
  })

  /** Where the picture's own pixels sit on screen: the element's content box, as object-fit draws an image in it. */
  function contentRect(el) {
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const px = (v) => parseFloat(v) || 0
    let left = r.left + px(cs.borderLeftWidth) + px(cs.paddingLeft)
    let top = r.top + px(cs.borderTopWidth) + px(cs.paddingTop)
    let width = r.width - px(cs.borderLeftWidth) - px(cs.paddingLeft) - px(cs.borderRightWidth) - px(cs.paddingRight)
    let height = r.height - px(cs.borderTopWidth) - px(cs.paddingTop) - px(cs.borderBottomWidth) - px(cs.paddingBottom)
    const natural = el instanceof HTMLImageElement ? [el.naturalWidth, el.naturalHeight] : el instanceof HTMLVideoElement ? [el.videoWidth, el.videoHeight] : null
    const fit = cs.objectFit
    if (natural && natural[0] && natural[1] && (fit === 'contain' || fit === 'cover' || fit === 'scale-down')) {
      const scale = (fit === 'cover' ? Math.max : Math.min)(width / natural[0], height / natural[1])
      const s = fit === 'scale-down' ? Math.min(1, scale) : scale
      const w = natural[0] * s
      const h = natural[1] * s
      left += (width - w) / 2
      top += (height - h) / 2
      width = w
      height = h
    }
    return { left, top, width, height }
  }

  /** How to get the picture: its own bytes (an image, a canvas, a video frame), else a cut of a screenshot. */
  function capturePlan() {
    const whole = { x: 0, y: 0, w: 1, h: 1 }
    if (!fetchFailed) {
      if (target instanceof HTMLImageElement && target.complete && target.naturalWidth) {
        const src = target.currentSrc || target.src
        if (/^(https?|data):/i.test(src)) return { src, region: whole }
        const drawn = drawToData(target, target.naturalWidth, target.naturalHeight)
        if (drawn) return { src: drawn, region: whole }
      }
      if (target instanceof HTMLCanvasElement) {
        try {
          return { src: target.toDataURL('image/png'), region: whole }
        } catch {
          // A canvas holding another site's pictures can't be read: the screenshot can.
        }
      }
      if (target instanceof HTMLVideoElement && target.videoWidth) {
        const drawn = drawToData(target, target.videoWidth, target.videoHeight)
        if (drawn) return { src: drawn, region: whole }
      }
    }
    const content = contentRect(target)
    const left = Math.max(0, content.left)
    const top = Math.max(0, content.top)
    const right = Math.min(innerWidth, content.left + content.width)
    const bottom = Math.min(innerHeight, content.top + content.height)
    if (right - left < 8 || bottom - top < 8) return null
    return {
      rect: { x: left, y: top, width: right - left, height: bottom - top },
      viewport: { width: innerWidth, height: innerHeight },
      region: {
        x: (left - content.left) / content.width,
        y: (top - content.top) / content.height,
        w: (right - left) / content.width,
        h: (bottom - top) / content.height,
      },
    }
  }

  function drawToData(source, width, height) {
    try {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      canvas.getContext('2d').drawImage(source, 0, 0, width, height)
      return canvas.toDataURL('image/png')
    } catch {
      return null
    }
  }

  async function scan(reason) {
    if (!target) return
    lastReason = reason
    // A reading that can't start isn't on its way.
    const notReading = () => {
      reading = false
      stashed = null
    }
    if (!target.isConnected && !reacquire()) {
      notReading()
      setMessage('The picture is gone from the page', 'warn')
      clearBoxes()
      render()
      return
    }
    if (status !== 'connected') {
      notReading()
      render()
      return
    }
    const plan = capturePlan()
    if (!plan) {
      notReading()
      if (reason !== 'auto') setMessage('Scroll the picture into view to read it', 'warn')
      render()
      return
    }
    const id = ++scanSeq
    latestScan = id
    if (reason !== 'auto') {
      reading = true
      setMessage('', 'busy')
      render()
    }
    if (plan.rect) {
      // A screenshot mustn't contain our own boxes or toolbar; they come back on `captured`.
      boxLayer.setAttribute('data-hide', '')
      uiHost.style.visibility = 'hidden'
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
    post({
      type: 'scan',
      id,
      reason,
      src: plan.src ?? null,
      rect: plan.rect ?? null,
      viewport: plan.viewport ?? null,
      region: plan.region,
      page: { title: document.title, url: location.href },
      session,
    })
  }

  function applyResult(msg) {
    reading = false
    const result = msg.result ?? {}
    const r = msg.region ?? { x: 0, y: 0, w: 1, h: 1 }
    region = r
    lines = (result.lines ?? []).map((line) => ({
      ...line,
      points: line.points.map(([x, y]) => [r.x + x * r.w, r.y + y * r.h]),
    }))
    if (result.geometry === false) setMessage(`Kimochi's engine (${result.engine}) reads text without places: it's in the Log`, 'warn')
    else setMessage('', 'ok')
    lastSize = ''
    layout()
    render()
  }

  // ------------------------------------------------------------------ drawing

  function clearBoxes() {
    lines = []
    region = null
    boxLayer.replaceChildren()
  }

  function scheduleLayout() {
    if (layoutFrame || !target) return
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0
      layout()
    })
  }

  /** Put the layer over the picture; rebuild the boxes when its size changed. */
  function layout() {
    if (!target || picking) return
    if (!target.isConnected) {
      boxLayer.setAttribute('hidden', '')
      return
    }
    const c = contentRect(target)
    if (c.width < 2 || c.height < 2) {
      boxLayer.setAttribute('hidden', '')
      return
    }
    boxLayer.removeAttribute('hidden')
    Object.assign(boxLayer.style, { left: `${c.left}px`, top: `${c.top}px`, width: `${c.width}px`, height: `${c.height}px` })
    const size = `${Math.round(c.width)}x${Math.round(c.height)}:${lines.length}:${settings?.grouping}`
    if (size === lastSize) return
    lastSize = size
    drawBoxes(c.width, c.height)
    gate()
  }

  function drawBoxes(width, height) {
    const fragment = document.createDocumentFragment()
    const grouped = settings?.grouping === true
    const groups = new Map()
    for (const line of lines) {
      const pts = line.points.map(([x, y]) => [x * width, y * height])
      if (pts.length < 4) continue
      const box = geometry(pts, line.vertical)
      const key = String(grouped ? line.group : `${line.group}:${groups.size}:${Math.random()}`)
      const el = document.createElement('div')
      el.className = `ocr-word${line.vertical ? ' ocr-vertical' : ''}${grouped ? ' kx-grouped' : ''}`
      el.dataset.group = grouped ? key : `w${fragment.childNodes.length}`
      const thickness = line.vertical ? box.w : box.h
      const length = line.vertical ? box.h : box.w
      const count = Math.max(1, [...line.text].length)
      let font = thickness * 0.86
      if (font * count > length) font = length / count
      const spacing = Math.max(0, (length - font * count) / count)
      Object.assign(el.style, {
        left: `${box.cx - box.w / 2}px`,
        top: `${box.cy - box.h / 2}px`,
        width: `${box.w}px`,
        height: `${box.h}px`,
        fontSize: `${font}px`,
        lineHeight: `${thickness}px`,
        letterSpacing: `${spacing}px`,
        transform: box.angle ? `rotate(${box.angle}rad)` : '',
      })
      el.style.setProperty('--ocr-pad', `${Math.round(Math.max(5, Math.min(14, font * 0.32)))}px`)
      if (line.surface) {
        el.dataset.surface = line.surface.ink
        el.style.setProperty('--ocr-surface-top', line.surface.top)
        el.style.setProperty('--ocr-surface-bottom', line.surface.bottom)
      }
      const text = document.createElement('span')
      text.className = 'ocr-word-text'
      // Half the spacing before the first glyph centres the run over the original's ink.
      text.style[line.vertical ? 'paddingTop' : 'paddingLeft'] = `${spacing / 2}px`
      text.textContent = line.text
      el.append(text)
      fragment.append(el)
      if (grouped) {
        const g = groups.get(key) ?? { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, surface: line.surface, vertical: line.vertical }
        g.left = Math.min(g.left, box.cx - box.w / 2)
        g.top = Math.min(g.top, box.cy - box.h / 2)
        g.right = Math.max(g.right, box.cx + box.w / 2)
        g.bottom = Math.max(g.bottom, box.cy + box.h / 2)
        groups.set(key, g)
      }
    }
    // Grouped (Group text into regions): one shared highlight and card per cluster, under its lines.
    const backs = document.createDocumentFragment()
    for (const [key, g] of groups) {
      const el = document.createElement('div')
      el.className = 'ocr-group'
      el.dataset.group = key
      const pad = 6
      Object.assign(el.style, {
        left: `${g.left - pad}px`,
        top: `${g.top - pad}px`,
        width: `${g.right - g.left + pad * 2}px`,
        height: `${g.bottom - g.top + pad * 2}px`,
        padding: '0',
      })
      if (g.surface) {
        el.dataset.surface = g.surface.ink
        el.style.setProperty('--ocr-surface-top', g.surface.top)
        el.style.setProperty('--ocr-surface-bottom', g.surface.bottom)
      }
      backs.append(el)
    }
    boxLayer.replaceChildren(backs, fragment)
    scheduleProximity()
  }

  /** A quadrilateral (top-left, top-right, bottom-right, bottom-left) as a centred, rotated box. */
  function geometry(pts, vertical) {
    const [a, b, , d] = pts
    let angle = Math.atan2(b[1] - a[1], b[0] - a[0])
    let w = Math.hypot(b[0] - a[0], b[1] - a[1])
    let h = Math.hypot(d[0] - a[0], d[1] - a[1])
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2
    // Upright text, or corners in an order this doesn't expect: the plain bounding box.
    if (Math.abs(angle) < 0.03 || Math.abs(angle) > Math.PI / 4 || vertical) {
      angle = 0
      w = Math.max(...xs) - Math.min(...xs)
      h = Math.max(...ys) - Math.min(...ys)
    }
    return { cx, cy, w, h, angle }
  }

  // ------------------------------------------------------------------ following the page

  window.addEventListener('scroll', () => scheduleLayout(), { capture: true, passive: true })
  window.addEventListener('resize', () => scheduleLayout(), { passive: true })

  let scrollTimer = 0
  window.addEventListener(
    'scroll',
    () => {
      // A picture read off the screen while partly out of view: read the rest once it's in view.
      if (!autoOn() || !region || (region.w > 0.98 && region.h > 0.98)) return
      clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => scan('auto'), 500)
    },
    { capture: true, passive: true }
  )

  const autoOn = () => active && autoMode && settings?.active !== false

  /** Watching the picture for changes: always to keep the boxes in place, and with Auto OCR on to read it again. */
  function syncWatch() {
    unwatch()
    if (!target) return
    const resize = new ResizeObserver(() => scheduleLayout())
    resize.observe(target)
    watchers.push(() => resize.disconnect())
    const poll = setInterval(() => {
      pageChanged()
      scheduleLayout()
      if (target && !target.isConnected && reacquire()) changed()
    }, 500)
    watchers.push(() => clearInterval(poll))
    // A new picture (its source, or what is inside the element) is read again; a new style or
    // class (a hover effect, a resize) only moves the boxes.
    const mutations = new MutationObserver((records) => {
      if (records.some((r) => r.type !== 'attributes' || r.attributeName === 'src' || r.attributeName === 'srcset')) changed()
      else scheduleLayout()
    })
    mutations.observe(target, { attributes: true, attributeFilter: ['src', 'srcset', 'style', 'class'], childList: true, subtree: true, characterData: true })
    watchers.push(() => mutations.disconnect())
    const onLoad = () => changed()
    target.addEventListener('load', onLoad)
    watchers.push(() => target?.removeEventListener('load', onLoad))
    if (autoOn() && (target instanceof HTMLCanvasElement || target instanceof HTMLVideoElement)) {
      // A canvas or video changes without telling the DOM: look again now and then (the worker
      // compares a small fingerprint and only bothers Kimochi when the pixels changed).
      const timer = setInterval(() => !reading && scan('auto'), POLL_MS)
      watchers.push(() => clearInterval(timer))
    }
  }

  function unwatch() {
    for (const stop of watchers) stop()
    watchers = []
  }

  /** The picture changed (a new page in a reader): read it again with Auto OCR, else drop the stale boxes. */
  function changed() {
    clearTimeout(mutationTimer)
    if (autoOn()) {
      // The old picture's boxes never show over the new one: they go now, and the toolbar says a
      // reading is on its way. If the pixels turn out the same, they come back (`unchanged`).
      if (lines.length) {
        stashed = { lines, region }
        clearBoxes()
        lastSize = ''
      }
      reading = true
      setMessage('', 'busy')
      render()
    }
    mutationTimer = setTimeout(() => {
      lastSize = ''
      if (autoOn()) scan('auto')
      else if (lines.length && target instanceof HTMLImageElement) {
        clearBoxes()
        post({ type: 'forget' })
        setMessage('The picture changed: read it again', 'neutral')
        render()
      }
    }, AUTO_DEBOUNCE_MS)
  }

  /** A reader that swaps the whole element for the next page: take the one now in its place. */
  function reacquire() {
    const rect = boxLayer.getBoundingClientRect()
    let next = rect.width ? pictureAt(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
    if (next && next.tagName !== target.tagName) next = null
    // A reader that rebuilt its page: the picture in the same place in it.
    if (!next && lastSignature) {
      const like = findLike(lastSignature)
      if (like && like !== 'wait') next = like
    }
    if (!next) return false
    target = next
    fetchFailed = false
    syncWatch()
    return true
  }

  // ------------------------------------------------------------------ the toolbar

  function setMessage(text, tone) {
    message = text
    messageTone = tone
  }

  function render() {
    hud.toggleAttribute('data-on', active)
    autoToggle.setAttribute('aria-checked', String(autoMode))
    autoToggle.dataset.tip = autoMode
      ? 'Auto is on: the picture is read again when it changes, and on the next page'
      : 'Auto is off: read the picture again yourself'
    const connected = status === 'connected'
    const opening = message === 'Opening Kimochi…'
    buttons.read.disabled = !target || !connected || reading
    buttons.session.disabled = !connected
    engineButton.disabled = !connected
    buttons.open.dataset.tip = connected ? 'Open Kimochi' : 'Start Kimochi'
    // The pip on the logo: green while connected, amber while waiting on Kimochi, red without it.
    hudPip.dataset.tone = !connected ? (status === 'offline' && !opening ? 'danger' : 'busy') : reading ? 'busy' : messageTone === 'danger' ? 'danger' : 'ok'
    let text = message
    let tone = messageTone
    if (status === 'connecting' || status === 'idle') text = 'Connecting to Kimochi…'
    else if (status === 'offline') {
      text = opening ? message : 'Kimochi isn’t running'
      tone = opening ? 'neutral' : 'danger'
    } else if (picking) text = 'Pick a picture'
    else if (reading) text = 'Reading…'
    else if (!target) text = 'Pick a picture to read'
    else if (!text) text = lines.length ? `${lines.length} line${lines.length === 1 ? '' : 's'} found` : 'No text found'
    hudMsg.dataset.tone = tone === 'danger' ? 'danger' : ''
    hudMsg.textContent = text
    const current = sessionById(session)
    sessionName.textContent = current ? current.name : 'New session'
    sessionName.toggleAttribute('data-new', !current)
    buttons.session.setAttribute('aria-label', `Session: ${sessionName.textContent}`)
  }

  // ------------------------------------------------------------------ on and off

  function activate() {
    if (active) return
    active = true
    mount()
    if (!port) connectPort()
  }

  function stop() {
    active = false
    stopPicking()
    unwatch()
    clearBoxes()
    target = null
    lastSignature = null
    try {
      port?.postMessage({ type: 'forget-target' })
      port?.postMessage({ type: 'stop' })
      port?.disconnect()
    } catch {
      // Already gone.
    }
    port = null
    status = 'idle'
    reading = false
    session = null
    pageAsked = false
    closeMenu()
    setMessage('', 'neutral')
    boxLayer.remove()
    uiHost.remove()
    sheet.remove()
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'activate') startPicking()
    else if (msg.type === 'resume') resume(msg.signature)
  })
})()

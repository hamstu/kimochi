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

  // One below the pop-up dictionaries' 2147483647 (the toolbar is Z + 1), so their popups are on top.
  const Z = 2147483645
  const PROXIMITY = 300
  const MIN_SIZE = 24
  const POLL_MS = 1500

  /** @type {chrome.runtime.Port|null} */
  let port = null
  let status = 'idle'
  let settings = null
  let css = null
  let active = false
  let picking = false
  let candidate = null
  /** The smaller picks ↑ widened from, for ↓ to go back to. */
  let widened = []
  /** What the reader picked: a picture, or a container of pictures (see `refresh`). */
  let target = null
  let scanSeq = 0
  let message = ''
  let messageTone = 'neutral'
  let shift = false
  /** The layer stays open after Shift is let go while the pointer is on a lit box. */
  let held = false
  let pointer = { x: -1, y: -1 }

  // ------------------------------------------------------------------ elements

  const boxLayer = document.createElement('div')
  boxLayer.id = 'kimochi-ext-boxes'
  const sheet = document.createElement('style')
  sheet.id = 'kimochi-ext-style'
  // How the page's layer differs from the overlay window: one fixed layer over the picture, and
  // the click-through gate (the overlay does it natively, `Region::shift`).
  const OWN_CSS = `
@font-face{font-family:"Kimochi Figtree";src:url("${chrome.runtime.getURL('fonts/figtree.woff2')}") format("woff2");font-weight:300 900;font-display:swap;}
#kimochi-ext-boxes{all:initial;display:block;position:fixed!important;inset:0 auto auto 0!important;width:0!important;height:0!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;z-index:${Z}!important;pointer-events:none!important;}
#kimochi-ext-boxes .kx-pic{position:fixed;margin:0;padding:0;border:0;pointer-events:none;}
#kimochi-ext-boxes .kx-pic[hidden]{display:none!important;}
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
  uiHost.style.cssText = `position:fixed!important;inset:0!important;width:auto!important;height:auto!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:visible!important;z-index:${Z + 1}!important;pointer-events:none!important;display:block!important;`
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
  .get{position:relative;margin:0 8px 0 -2px;padding:3px 10px;border-radius:999px;background:var(--accent);color:#fff;font-weight:600;text-decoration:none;white-space:nowrap;pointer-events:auto}
  .get:hover{filter:brightness(1.08)}
  .get[hidden]{display:none}
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
  <div class="banner panel" role="status"><strong>Click a picture for Kimochi to read</strong><span class="hint"><kbd>↑</kbd><kbd>↓</kbd> bigger or smaller area</span><span class="hint"><kbd>Esc</kbd> cancel</span></div>
  <div class="bar panel" role="toolbar" aria-label="Kimochi">
    <span class="logo"><img alt="Kimochi"><span class="pip"></span></span>
    <span class="msg" role="status"></span>
    <a class="get" href="https://kimochiapp.com" target="_blank" rel="noopener" data-tip="This extension works with the free Kimochi desktop app" hidden>Get the app</a>
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
  const getApp = shadow.querySelector('.get')
  const autoToggle = shadow.querySelector('.toggle')
  const engineButton = shadow.querySelector('.engine')
  const menu = shadow.querySelector('.menu')
  const sessionName = shadow.querySelector('[data-act=session] .name')
  const buttons = Object.fromEntries([...shadow.querySelectorAll('button[data-act]')].map((b) => [b.dataset.act, b]))

  hud.addEventListener('click', (event) => {
    const action = event.target.closest?.('button')?.dataset.act
    if (action === 'open') openKimochi()
    else if (action === 'read') rescanAll()
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
    if (on) refresh('auto')
  }

  function mount() {
    if (!sheet.isConnected) (document.head || document.documentElement).append(sheet)
    raise(true)
    applyLook()
    startRaising()
  }

  // ------------------------------------------------------------------ staying on top

  // The pop-up dictionaries must always be above the boxes. Yomitan and Hachidori use
  // `z-index: 2147483647` in the page; 10ten puts its popup in the browser's top layer and shows it
  // again each time, so it lands last. So the boxes and the toolbar sit one z-index below theirs.
  //
  // A page's lightbox or viewer can sit above any z-index: a modal <dialog>, a big popover or a
  // fullscreen element is in the top layer. Only while one is open do the boxes and the toolbar
  // join the top layer too (shown again, so they're last). A modal dialog also makes everything
  // outside it inert (no clicks, no hover lookups), so while one is open both layers live inside it.
  const POPOVERS = typeof HTMLElement.prototype.showPopover === 'function'
  const LAYERS = [boxLayer, uiHost]

  /** The open modal dialog the page shows last (on top), else the page itself. */
  let modals = []
  function layerParent() {
    const open = [...document.querySelectorAll('dialog')].filter((d) => d.isConnected && d.matches(':modal'))
    modals = modals.filter((d) => open.includes(d))
    for (const d of open) if (!modals.includes(d)) modals.push(d)
    return modals.at(-1) ?? document.documentElement
  }

  // Another extension's overlay (a dictionary's popup or puck), never the page's own lightbox.
  const DICTIONARIES = /^(tenten-|hachidori|yomitan|gsm-hoshidicts)/i
  function foreignOverlay(el) {
    if (DICTIONARIES.test(el.id) || DICTIONARIES.test(el.localName) || [...el.classList].some((c) => DICTIONARIES.test(c))) return true
    // Overlay containers that let the pointer through (10ten's is the whole viewport) aren't viewers.
    return getComputedStyle(el).pointerEvents === 'none'
  }

  /** Something of the page's in the top layer that would cover the boxes or the toolbar. */
  function covers(el) {
    if (!(el instanceof Element) || LAYERS.includes(el) || !el.isConnected) return false
    if (el === document.fullscreenElement) return true
    if (el.localName === 'dialog' && el.matches(':modal')) return true
    if (!el.matches(':popover-open') || foreignOverlay(el)) return false
    // Small popovers (the page's menus) stay above the boxes.
    const r = el.getBoundingClientRect()
    return r.width * r.height >= innerWidth * innerHeight * 0.4
  }

  function needTop() {
    if (!POPOVERS) return false
    if (layerParent() !== document.documentElement || document.fullscreenElement) return true
    return [...document.querySelectorAll(':popover-open')].some(covers)
  }

  /** Put the layers where they belong; `again` re-shows them in the top layer to land on top. */
  let onTop = false
  function raise(again = false) {
    const parent = layerParent()
    for (const el of LAYERS) if (el.parentNode !== parent) parent.append(el)
    const top = needTop()
    for (const el of LAYERS) {
      try {
        if (top) {
          if (!el.matches(':popover-open')) {
            el.popover = 'manual'
            el.showPopover()
          } else if (again) {
            el.hidePopover()
            el.showPopover()
          }
        } else if (el.hasAttribute('popover')) {
          if (el.matches(':popover-open')) el.hidePopover()
          el.removeAttribute('popover')
        }
      } catch {
        // Not connected, or the page is mid-change; the next check puts it right.
      }
    }
    onTop = top
  }

  let raiseTimer = 0
  let raiseQueued = false
  let raiseAgain = false
  let lastRaise = 0
  function raiseSoon(again) {
    raiseAgain ||= again
    if (!active || raiseQueued) return
    raiseQueued = true
    // At most a few times a second, so a page doing the same can't ping-pong with us.
    const wait = Math.max(0, lastRaise + 250 - performance.now())
    setTimeout(() => {
      raiseQueued = false
      if (!active) return
      lastRaise = performance.now()
      const again = raiseAgain
      raiseAgain = false
      raise(again)
    }, wait)
  }

  function onToggle(event) {
    const el = event.target
    if (!(el instanceof Element) || LAYERS.includes(el)) return
    if (event.type === 'toggle' && event.newState === 'open') {
      if (covers(el)) raiseSoon(true)
    } else if (el.localName === 'dialog' || el.matches('[popover]')) raiseSoon(false)
  }
  function onFullscreen() {
    raiseSoon(true)
  }
  const dialogWatch = new MutationObserver((records) => {
    if (records.some((r) => r.target.localName === 'dialog')) raiseSoon(true)
  })

  function startRaising() {
    if (raiseTimer) return
    window.addEventListener('toggle', onToggle, true)
    window.addEventListener('close', onToggle, true)
    document.addEventListener('fullscreenchange', onFullscreen, true)
    dialogWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['open'], subtree: true })
    // A dialog removed with us inside it, or one opened or closed without an event we see.
    raiseTimer = setInterval(() => {
      if (!active) return
      const parent = layerParent()
      if (LAYERS.some((el) => el.parentNode !== parent) || needTop() !== onTop || (onTop && LAYERS.some((el) => !el.matches(':popover-open')))) raise()
    }, 700)
  }

  function stopRaising() {
    clearInterval(raiseTimer)
    raiseTimer = 0
    window.removeEventListener('toggle', onToggle, true)
    window.removeEventListener('close', onToggle, true)
    document.removeEventListener('fullscreenchange', onFullscreen, true)
    dialogWatch.disconnect()
    modals = []
    onTop = false
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
        if (status === 'connected') {
          if (target && !pics.size) refresh(lastReason)
          pump()
        } else if (inflight) {
          // Kimochi went away mid-reading: that reading isn't coming. Read it again on reconnect.
          clearTimeout(inflight.timer)
          queue.unshift(inflight.p)
          inflight = null
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
          queue = []
          setMessage('Kimochi switched to another source', 'warn')
          render()
        }
        break
      case 'rescan':
        rescanAll()
        break
      case 'captured':
        boxLayer.removeAttribute('data-hide')
        uiHost.style.visibility = ''
        break
      case 'reading':
        break
      case 'unchanged':
        finish(msg.id, (p) => {
          // The same pixels after all: the boxes kept aside for the reading were right.
          if (p.stashed) setLines(p, p.stashed.lines, p.stashed.region)
          p.stashed = null
          p.state = 'done'
          layout()
        })
        break
      case 'result':
        if (inflight?.id === msg.id) {
          if (msg.result?.session) session = msg.result.session
          applyResult(msg)
          rememberTarget()
        }
        break
      case 'error':
        if (inflight?.id !== msg.id) break
        if (msg.message === 'fetch-failed') {
          // The picture's own bytes couldn't be had: read it off the screen instead.
          const p = inflight.p
          finish(msg.id, () => {
            p.fetchFailed = true
            enqueue(p, p.reason)
          })
          break
        }
        finish(msg.id, (p) => {
          p.state = 'error'
          p.stashed = null
        })
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
    widened = []
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
      pictureUnder(stack, x, y) ??
      stack.find((el) => hasBackground(el) && sized(el) && el !== document.body && el !== document.documentElement) ??
      stack.find((el) => sized(el) && el !== document.body && el !== document.documentElement) ??
      null
    )
  }

  /**
   * A picture at the point that doesn't take the pointer (`pointer-events: none`, or under a
   * transparent cover, as readers do to stop saving): found among the pointed elements' own.
   */
  function pictureUnder(stack, x, y) {
    for (const el of stack.slice(0, 6)) {
      if (el === document.body || el === document.documentElement) continue
      for (const pic of el.querySelectorAll('img, canvas, video')) {
        const r = pic.getBoundingClientRect()
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom && sized(pic) && visibleRect(pic)) return pic
      }
    }
    return null
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
        // A pick widened with ↑ stays while the pointer stays inside it.
        if (widened.length && candidate?.contains(next)) return
        widened = []
        if (next !== candidate) {
          candidate = next
          showCandidate()
        }
        return
      }
      if (pics.size) scheduleProximity()
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
        } else if (event.key === 'ArrowUp' && candidate?.parentElement && candidate.parentElement !== document.body && candidate.parentElement !== document.documentElement) {
          event.preventDefault()
          widened.push(candidate)
          candidate = candidate.parentElement
          showCandidate()
        } else if (event.key === 'ArrowDown' && widened.length) {
          event.preventDefault()
          candidate = widened.pop()
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

  /**
   * What the reader picked (`target`) is a scope: a picture, or a container whose pictures are
   * read one by one, as many as are in view (a reader's two-page spread, a slider's current
   * slide). Each picture in view is a `Pic`, with its own layer of boxes over it; a picture that
   * leaves view loses its layer, one that comes into view is read, and a reading is kept by the
   * picture (`cache`) so sliding back shows its boxes at once. Pictures are read one at a time.
   */
  const MAX_PICS = 4
  const MAX_CACHE = 80
  const READ_TIMEOUT_MS = 75_000
  /** el -> Pic: `{id, el, key, layer, lines, region, state, fetchFailed, stashed, size}` */
  const pics = new Map()
  /** A picture's key (its source and size) -> its reading `{lines, region}`. */
  const cache = new Map()
  let picSeq = 0
  /** Pics waiting to be read, in reading order; the one being read. */
  let queue = []
  let inflight = null
  /** A reading is on its way though no picture is known yet (a page change, a page load). */
  let waiting = false
  let lastReason = 'select'

  const busy = () => waiting || Boolean(inflight) || queue.length > 0
  const lineCount = () => [...pics.values()].reduce((n, p) => n + p.lines.length, 0)

  function choose(element, reason = 'select') {
    if (target !== element) {
      unwatch()
      dropAll()
      target = element
    }
    lastReason = reason
    // Where it is now: a newly picked (or replaced) scope's place, until it settles somewhere else.
    if (inView(element)) lastSpot = element.getBoundingClientRect()
    lastLook = null
    syncWatch()
    rememberTarget()
    refresh(reason)
  }

  /** The part of `el` that can be seen: inside the window and every scrolling or clipping box around it. */
  function visibleRect(el) {
    if (!el.isConnected) return null
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null
    const r = el.getBoundingClientRect()
    let left = Math.max(0, r.left)
    let top = Math.max(0, r.top)
    let right = Math.min(innerWidth, r.right)
    let bottom = Math.min(innerHeight, r.bottom)
    for (let a = el.parentElement; a && a !== document.documentElement && right > left && bottom > top; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible' && cs.clipPath === 'none') continue
      const b = a.getBoundingClientRect()
      left = Math.max(left, b.left)
      top = Math.max(top, b.top)
      right = Math.min(right, b.right)
      bottom = Math.min(bottom, b.bottom)
    }
    if (right - left < 4 || bottom - top < 4) return null
    return { left, top, right, bottom, width: right - left, height: bottom - top, full: r }
  }

  /** Enough of it shows to be what the reader is looking at. */
  function inView(el, loose = false) {
    const v = visibleRect(el)
    if (!v) return false
    if (loose) return true
    const area = v.width * v.height
    const whole = Math.max(1, v.full.width * v.full.height)
    return area / whole >= 0.5 || area >= 0.25 * innerWidth * innerHeight
  }

  /** The pictures the scope holds that are in view, in reading order (right to left, as manga pages). */
  function picturesIn(scope) {
    if (isPicture(scope)) return inView(scope, true) ? [scope] : []
    const found = [...scope.querySelectorAll('img, canvas, video')].filter((el) => !isOurs(el) && sized(el) && inView(el))
    if (!found.length) return inView(scope, true) ? [scope] : []
    return found
      .map((el) => ({ el, v: visibleRect(el) }))
      .sort((a, b) => b.v.width * b.v.height - a.v.width * a.v.height)
      .slice(0, MAX_PICS)
      .sort((a, b) => (Math.abs(a.v.top - b.v.top) > 40 ? a.v.top - b.v.top : b.v.left - a.v.left))
      .map(({ el }) => el)
  }

  /** A picture's identity for the cache: its source and size, once loaded; none for what changes in place. */
  function keyOf(el) {
    if (el instanceof HTMLImageElement) {
      if (!el.complete || !el.naturalWidth) return 'loading'
      const src = el.currentSrc || el.src
      // By its pixels where the page lets them be read: readers hand out a new blob: address for
      // the same page each time its slide comes back.
      if (!fingerprints.has(src)) {
        fingerprints.set(src, fingerprintOf(el))
        if (fingerprints.size > 300) fingerprints.delete(fingerprints.keys().next().value)
      }
      return `${fingerprints.get(src) ?? src}|${el.naturalWidth}x${el.naturalHeight}`
    }
    return null
  }

  /** src -> a picture's fingerprint (or null where another site's pixels can't be read). */
  const fingerprints = new Map()
  const printCanvas = document.createElement('canvas')
  printCanvas.width = printCanvas.height = 12
  function fingerprintOf(img) {
    try {
      const context = printCanvas.getContext('2d', { willReadFrequently: true })
      context.drawImage(img, 0, 0, 12, 12)
      const { data } = context.getImageData(0, 0, 12, 12)
      let print = 'px:'
      for (let i = 0; i < data.length; i += 4) print += ((data[i] * 3 + data[i + 1] * 6 + data[i + 2]) / 160 | 0).toString(16)
      return print
    } catch {
      return null
    }
  }

  let refreshTimer = 0
  /** Look again soon (a scroll, a slide, a change in the scope); at most a few times a second, never put off forever. */
  function scheduleRefresh() {
    if (refreshTimer) return
    refreshTimer = setTimeout(() => {
      refreshTimer = 0
      refresh('auto')
    }, 150)
  }

  /** Bring the pictures in view and their boxes up to date. */
  function refresh(reason) {
    if (!active || !target || picking) return
    // Taken off the page (readers keep only the slides near the current one): what took its place.
    if (!target.isConnected && lastSpot) {
      const next = replacementAt(lastSpot, target)
      if (next) {
        choose(next, 'auto')
        return
      }
    }
    if (!target.isConnected && !reacquire()) {
      dropAll()
      waiting = false
      setMessage('The picture is gone from the page', 'warn')
      render()
      return
    }
    // What was picked slid out of view (a slider's page turn, a carousel), and something like it
    // is now where it was: that is what the reader is looking at, so it becomes the scope.
    if (lastSpot && !inView(target, true)) {
      const next = replacementAt(lastSpot, target)
      if (next) {
        choose(next, 'auto')
        return
      }
    }
    const wanted = picturesIn(target)
    for (const [el, p] of pics) if (!wanted.includes(el)) dropPic(p)
    for (const el of wanted) {
      const key = keyOf(el)
      const p = pics.get(el)
      if (!p) addPic(el, key, reason)
      else if (key !== p.key) changedPic(p, key)
    }
    // Only once it has settled in view (the same place on two looks), never as it slides away.
    const now = target.getBoundingClientRect()
    const still = lastLook && Math.abs(lastLook.left - now.left) < 1 && Math.abs(lastLook.top - now.top) < 1
    if (still && inView(target)) lastSpot = now
    lastLook = now
    layout()
    pump()
    render()
  }

  /** Where the scope last showed, to find what took its place when it slides away. */
  let lastSpot = null
  let lastLook = null

  /**
   * The element now where `old` showed (`spot`) and like it: the same kind of element, about the
   * same size, in view, and (for a container) mostly the same classes. Looked for among what is at
   * the spot's centre and the elements around the picture there.
   */
  function replacementAt(spot, old) {
    const x = spot.left + spot.width / 2
    const y = spot.top + spot.height / 2
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null
    const stack = document.elementsFromPoint(x, y).filter((el) => !isOurs(el))
    const found = new Set(stack)
    const picture = stack.find((el) => isPicture(el)) ?? pictureUnder(stack, x, y)
    for (let a = picture; a && a !== document.body; a = a.parentElement) found.add(a)
    const classes = stableClasses(old)
    const shared = (a, b) => (a.length || b.length ? a.filter((c) => b.includes(c)).length / new Set([...a, ...b]).size : 1)
    let best = null
    let bestLike = 0
    for (const el of found) {
      if (el === old || el.tagName !== old.tagName || el.contains(old) || old.contains(el)) continue
      if (!isPicture(old) && shared(stableClasses(el), classes) < 0.5) continue
      if (!inView(el, true)) continue
      const like = similarSize(el.getBoundingClientRect(), spot)
      if (like > 0.5 && like > bestLike) {
        best = el
        bestLike = like
      }
    }
    return best
  }
  const similarSize = (a, b) =>
    !a.width || !b.width ? 0 : Math.min(a.width / b.width, b.width / a.width) * Math.min(a.height / b.height, b.height / a.height)

  function addPic(el, key, reason) {
    const layer = document.createElement('div')
    layer.className = 'kx-pic'
    boxLayer.append(layer)
    const p = { id: ++picSeq, el, key, layer, lines: [], region: null, state: 'new', fetchFailed: false, stashed: null, size: '' }
    pics.set(el, p)
    place(p, reason)
  }

  /** Show what is known about the picture, else read it (always when picked; with Auto on otherwise). */
  function place(p, reason) {
    const known = p.key && p.key !== 'loading' ? cache.get(p.key) : null
    if (known) {
      setLines(p, known.lines, known.region)
      p.state = 'done'
      waiting = false
      return
    }
    if (p.key === 'loading') {
      p.state = 'loading'
      return
    }
    if (reason !== 'auto' || autoOn()) enqueue(p, reason)
    else {
      p.state = 'stale'
      setMessage('The picture changed: read it again', 'neutral')
    }
  }

  /** The picture's source changed (a reader's next page in the same element). */
  function changedPic(p, key) {
    // The old boxes never show over the new picture; kept aside in case the pixels are the same.
    if (p.lines.length) p.stashed = { lines: p.lines, region: p.region }
    setLines(p, [], null)
    p.key = key
    queue = queue.filter((q) => q !== p)
    place(p, 'auto')
  }

  function dropPic(p) {
    queue = queue.filter((q) => q !== p)
    p.layer.remove()
    pics.delete(p.el)
  }

  function dropAll() {
    for (const p of [...pics.values()]) dropPic(p)
    queue = []
    inflight = null
  }

  function enqueue(p, reason) {
    if (!queue.includes(p) && inflight?.p !== p) queue.push(p)
    p.reason = reason
    p.state = 'queued'
    pump()
  }

  /** Read the next picture in line, if nothing is being read. */
  async function pump() {
    if (inflight || status !== 'connected') return
    let p = queue.shift()
    while (p && !pics.has(p.el)) p = queue.shift()
    if (!p) {
      render()
      return
    }
    waiting = false
    const plan = capturePlan(p)
    if (!plan) {
      p.state = 'error'
      if (p.reason !== 'auto') setMessage('Scroll the picture into view to read it', 'warn')
      pump()
      return
    }
    const id = ++scanSeq
    inflight = { id, p, plan }
    p.state = 'reading'
    render()
    // A reading that never comes back (Kimochi stopped mid-way) mustn't hold up the rest.
    inflight.timer = setTimeout(() => {
      if (inflight?.id !== id) return
      finish(id, () => {
        p.state = 'error'
        setMessage('Kimochi took too long to read that', 'danger')
      })
    }, READ_TIMEOUT_MS)
    if (plan.rect) {
      // A screenshot mustn't contain our own boxes or toolbar; they come back on `captured`.
      boxLayer.setAttribute('data-hide', '')
      uiHost.style.visibility = 'hidden'
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }
    post({
      type: 'scan',
      id,
      reason: p.reason ?? 'auto',
      // Nothing on screen to fall back on: the worker reads it even if it looks the same as before.
      fresh: !p.stashed,
      src: plan.src ?? null,
      rect: plan.rect ?? null,
      viewport: plan.viewport ?? null,
      region: plan.region,
      page: { title: document.title, url: location.href },
      session,
    })
  }

  /** The reading `id` is over: `apply` it, then read the next picture. */
  function finish(id, apply) {
    if (inflight?.id !== id) return
    clearTimeout(inflight.timer)
    const p = inflight.p
    inflight = null
    if (pics.has(p.el)) apply(p)
    pump()
    render()
  }

  function setLines(p, lines, region) {
    p.lines = lines
    p.region = region
    p.size = ''
  }

  function applyResult(msg) {
    finish(msg.id, (p) => {
      const result = msg.result ?? {}
      const r = msg.region ?? { x: 0, y: 0, w: 1, h: 1 }
      const lines = (result.lines ?? []).map((line) => ({
        ...line,
        points: line.points.map(([x, y]) => [r.x + x * r.w, r.y + y * r.h]),
      }))
      setLines(p, lines, r)
      p.stashed = null
      p.state = 'done'
      if (p.key && p.key !== 'loading') {
        cache.set(p.key, { lines, region: r })
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
      }
      if (result.geometry === false) setMessage(`Kimochi's engine (${result.engine}) reads text without places: it's in the Log`, 'warn')
      else setMessage('', 'ok')
      layout()
    })
  }

  /** How to get a picture: its own bytes (an image, a canvas, a video frame), else a cut of a screenshot. */
  function capturePlan(p) {
    const el = p.el
    const whole = { x: 0, y: 0, w: 1, h: 1 }
    if (!p.fetchFailed) {
      if (el instanceof HTMLImageElement && el.complete && el.naturalWidth) {
        const src = el.currentSrc || el.src
        if (/^(https?|data):/i.test(src)) return { src, region: whole }
        // blob: and the like belong to the page: draw it here.
        const drawn = drawToData(el, el.naturalWidth, el.naturalHeight)
        if (drawn) return { src: drawn, region: whole }
      }
      if (el instanceof HTMLCanvasElement) {
        const drawn = drawToData(el, el.width, el.height)
        if (drawn) return { src: drawn, region: whole }
      }
      if (el instanceof HTMLVideoElement && el.videoWidth) {
        const drawn = drawToData(el, el.videoWidth, el.videoHeight)
        if (drawn) return { src: drawn, region: whole }
      }
    }
    // Only what can be seen: the window and every clipping box around it.
    const content = contentRect(el)
    const v = visibleRect(el)
    if (!v) return null
    const left = Math.max(v.left, content.left)
    const top = Math.max(v.top, content.top)
    const right = Math.min(v.right, content.left + content.width)
    const bottom = Math.min(v.bottom, content.top + content.height)
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

  /** The picture as a PNG data URL, no larger than Kimochi will read (4096 on its long side). */
  function drawToData(source, width, height) {
    if (!width || !height) return null
    const scale = Math.min(1, 4096 / Math.max(width, height))
    try {
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height)
      return canvas.toDataURL('image/png')
    } catch {
      // Another site's pixels (a tainted canvas): the screenshot can still read it.
      return null
    }
  }

  /** Read every picture in view again (Read again, or Kimochi's scan button). */
  function rescanAll() {
    if (!target) return
    refresh('rescan')
    for (const p of pics.values()) {
      if (p.key) cache.delete(p.key)
      p.stashed = p.lines.length ? { lines: p.lines, region: p.region } : null
      enqueue(p, 'rescan')
    }
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
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`
      parts.unshift(part)
    }
    return parts.join(' > ')
  }

  /**
   * The element on this page most like the remembered one: at the same path if it is about the
   * same size, else the element of the same kind closest to where it was and of a similar size,
   * its classes a tiebreak. None when nothing is close enough.
   */
  function findLike(signature) {
    const ready = (el) => !(el instanceof HTMLImageElement) || (el.complete && el.naturalWidth > 0)
    const want = { width: signature.rect.w, height: signature.rect.h }
    try {
      const at = document.querySelector(signature.path)
      if (at && !isOurs(at) && similarSize(at.getBoundingClientRect(), want) > 0.3) return ready(at) ? at : 'wait'
    } catch {
      // A path this page can't parse.
    }
    const spot = signature.rect
    const reach = Math.max(200, 0.6 * Math.max(spot.w, spot.h))
    let best = null
    let bestScore = -Infinity
    for (const el of document.querySelectorAll(signature.tag)) {
      if (isOurs(el)) continue
      const r = el.getBoundingClientRect()
      const like = similarSize(r, want)
      if (like < 0.3) continue
      const distance = Math.hypot(r.left + scrollX + r.width / 2 - (spot.x + spot.w / 2), r.top + scrollY + r.height / 2 - (spot.y + spot.h / 2))
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
    waiting = true
    setMessage('', 'busy')
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
        choose(found, 'auto')
        return
      }
      // Pages build themselves and pictures load late: keep looking a little while.
      if (Date.now() - started < 12_000) setTimeout(look, 400)
      else {
        waiting = false
        setMessage('No picture like the last one here: pick one', 'neutral')
        render()
      }
    }
    look()
  }

  // ------------------------------------------------------------------ a page change without a page load

  /**
   * Most galleries and readers change pages without loading a new document: they swap the content
   * and the URL. To the reader that is a new page, so it is treated as one: the boxes go the
   * moment the navigation starts (a full page load too, which keeps the old page on screen until
   * the new one paints), the toolbar says a reading is coming, and once the new content is in,
   * the picture in the same place on it is found again and read.
   */
  let lastHref = location.href
  let navTimer = 0

  function leavingPage() {
    if (!active || (!target && !lastSignature)) return
    for (const p of pics.values()) setLines(p, [], null)
    layout()
    if (autoOn()) {
      waiting = true
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
      unwatch()
      dropAll()
      target = null
      lookFor(signature)
    }, 250)
  }

  // The Navigation API (Chrome) says when a navigation starts and when one in the page is done.
  window.navigation?.addEventListener('navigate', () => leavingPage())
  window.navigation?.addEventListener('navigatesuccess', () => pageChanged())
  window.addEventListener('popstate', () => pageChanged())
  // Leaving for another document: nothing stale stays up while the old page is still shown.
  window.addEventListener('pagehide', () => boxLayer.setAttribute('hidden', ''))
  // Back from the back/forward cache: the page as it was, looked at again in case it changed.
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || !active) return
    boxLayer.removeAttribute('hidden')
    refresh('auto')
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

  // ------------------------------------------------------------------ drawing

  function clearBoxes() {
    for (const p of pics.values()) setLines(p, [], null)
    layout()
  }

  let layoutFrame = 0
  function scheduleLayout() {
    if (layoutFrame || !target) return
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = 0
      layout()
    })
  }

  /** Put each picture's layer over it, clipped to what of it can be seen; redraw a layer whose size changed. */
  function layout() {
    if (picking) return
    for (const p of pics.values()) {
      const v = p.lines.length ? visibleRect(p.el) : null
      const c = v ? contentRect(p.el) : null
      if (!v || c.width < 2 || c.height < 2) {
        p.layer.hidden = true
        continue
      }
      p.layer.hidden = false
      Object.assign(p.layer.style, { left: `${c.left}px`, top: `${c.top}px`, width: `${c.width}px`, height: `${c.height}px` })
      // Boxes stop where the picture stops showing (a slider's frame, a scrolling box).
      const clip = [v.top - c.top, c.left + c.width - v.right, c.top + c.height - v.bottom, v.left - c.left].map((n) => `${Math.max(0, n)}px`)
      p.layer.style.clipPath = `inset(${clip.join(' ')})`
      const size = `${Math.round(c.width)}x${Math.round(c.height)}:${p.lines.length}:${settings?.grouping}`
      if (size === p.size) continue
      p.size = size
      drawBoxes(p, c.width, c.height)
    }
    gate()
  }

  function drawBoxes(p, width, height) {
    const fragment = document.createDocumentFragment()
    const grouped = settings?.grouping === true
    const groups = new Map()
    p.lines.forEach((line, index) => {
      const pts = line.points.map(([x, y]) => [x * width, y * height])
      if (pts.length < 4) return
      const box = geometry(pts, line.vertical)
      // Unique across pictures: lighting a group never lights another picture's.
      const key = grouped ? `p${p.id}g${line.group}` : `p${p.id}w${index}`
      const el = document.createElement('div')
      el.className = `ocr-word${line.vertical ? ' ocr-vertical' : ''}${grouped ? ' kx-grouped' : ''}`
      el.dataset.group = key
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
        const g = groups.get(key) ?? { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity, surface: line.surface }
        g.left = Math.min(g.left, box.cx - box.w / 2)
        g.top = Math.min(g.top, box.cy - box.h / 2)
        g.right = Math.max(g.right, box.cx + box.w / 2)
        g.bottom = Math.max(g.bottom, box.cy + box.h / 2)
        groups.set(key, g)
      }
    })
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
    p.layer.replaceChildren(backs, fragment)
    scheduleProximity()
  }

  /** A quadrilateral (top-left, top-right, bottom-right, bottom-left) as a centred, rotated box. */
  function geometry(pts, vertical) {
    const [a, b, , d] = pts
    let angle = Math.atan2(b[1] - a[1], b[0] - a[0])
    let w = Math.hypot(b[0] - a[0], b[1] - a[1])
    let h = Math.hypot(d[0] - a[0], d[1] - a[1])
    const xs = pts.map((pt) => pt[0])
    const ys = pts.map((pt) => pt[1])
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

  // Scrolling, sliding and resizing move pictures in and out of view: the layers follow every
  // frame, and which pictures are in view is looked at again shortly after.
  for (const type of ['scroll', 'transitionend', 'animationend']) {
    window.addEventListener(
      type,
      () => {
        scheduleLayout()
        scheduleRefresh()
      },
      { capture: true, passive: true }
    )
  }
  window.addEventListener('resize', () => {
    scheduleLayout()
    scheduleRefresh()
  }, { passive: true })
  // A picture in the scope finished loading (a slider's next page, a lazy image).
  document.addEventListener('load', (event) => {
    if (target && event.target instanceof HTMLImageElement && (target === event.target || target.contains(event.target))) scheduleRefresh()
  }, true)

  let scrollTimer = 0
  window.addEventListener(
    'scroll',
    () => {
      // A picture read off the screen while partly out of view: read the rest once it's in view.
      if (!autoOn()) return
      clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => {
        for (const p of pics.values()) {
          if (p.key === null && p.region && (p.region.w < 0.98 || p.region.h < 0.98)) {
            p.stashed = { lines: p.lines, region: p.region }
            enqueue(p, 'auto')
          }
        }
      }, 500)
    },
    { capture: true, passive: true }
  )

  const autoOn = () => active && autoMode && settings?.active !== false

  /** Watching the scope: always to keep the boxes in place, and with Auto on to read what changes. */
  let watchers = []
  function syncWatch() {
    unwatch()
    if (!target) return
    const resize = new ResizeObserver(() => {
      scheduleLayout()
      scheduleRefresh()
    })
    resize.observe(target)
    watchers.push(() => resize.disconnect())
    // Also catches what moves without an event (CSS animations) and a page that changes its URL.
    const poll = setInterval(() => {
      pageChanged()
      refresh('auto')
    }, 500)
    watchers.push(() => clearInterval(poll))
    const mutations = new MutationObserver((all) => {
      // Our own layers live inside the page's modal dialog while one is open: not the page's changes.
      const records = all.filter((r) => !isOurs(r.target) && !(r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every((n) => LAYERS.includes(n))))
      if (!records.length) return
      scheduleLayout()
      // A new picture (a source, or content put in): at once, so its old boxes never show over it.
      if (records.some((r) => r.type === 'childList' || r.attributeName === 'src' || r.attributeName === 'srcset')) refresh('auto')
      else scheduleRefresh()
    })
    mutations.observe(target, { attributes: true, attributeFilter: ['src', 'srcset', 'style', 'class'], childList: true, subtree: true, characterData: true })
    watchers.push(() => mutations.disconnect())
    // A canvas or video changes without telling the DOM: look again now and then (the worker
    // compares a small fingerprint and only bothers Kimochi when the pixels changed).
    const timer = setInterval(() => {
      if (!autoOn() || busy()) return
      for (const p of pics.values()) {
        if (p.el instanceof HTMLCanvasElement || p.el instanceof HTMLVideoElement) {
          p.stashed = { lines: p.lines, region: p.region }
          enqueue(p, 'auto')
        }
      }
    }, POLL_MS)
    watchers.push(() => clearInterval(timer))
  }

  function unwatch() {
    for (const stopWatching of watchers) stopWatching()
    watchers = []
  }

  /** A reader that swaps the whole element for the next page: take the one now in its place. */
  function reacquire() {
    let next = lastSpot ? pictureAt(lastSpot.left + lastSpot.width / 2, lastSpot.top + lastSpot.height / 2) : null
    if (next && target && next.tagName !== target.tagName) next = null
    // A reader that rebuilt its page: the element in the same place in it.
    if (!next && lastSignature) {
      const like = findLike(lastSignature)
      if (like && like !== 'wait') next = like
    }
    if (!next) return false
    unwatch()
    dropAll()
    target = next
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
      : 'Auto is off'
    const connected = status === 'connected'
    const opening = message === 'Opening Kimochi…'
    const reading = busy()
    const lines = lineCount()
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
    else if (!text) text = lines ? `${lines} line${lines === 1 ? '' : 's'} found` : pics.size ? 'No text found' : 'No picture in view'
    hudMsg.dataset.tone = tone === 'danger' ? 'danger' : ''
    hudMsg.textContent = text
    // Without the app nothing works: say where to get it.
    getApp.hidden = !(status === 'offline' && !opening)
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
    dropAll()
    waiting = false
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
    session = null
    pageAsked = false
    closeMenu()
    setMessage('', 'neutral')
    stopRaising()
    boxLayer.remove()
    uiHost.remove()
    sheet.remove()
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'activate') startPicking()
    else if (msg.type === 'resume') resume(msg.signature)
  })
})()

/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain script, run before any page code. */
/**
 * Touch input in Steam Deck Gaming Mode (Gamescope), for every page Kimochi shows: its own
 * windows and the dictionary extensions' settings pages alike. A classic script, not a module:
 * native appends it to the platform prelude (`platform_prelude`, src-tauri/src/platform/mod.rs),
 * so it runs in every frame before the page's own code. It installs itself only when
 * `__KIMOCHI_PLATFORM__.gamescope` is set.
 *
 * - **Drop-down lists.** WebKitGTK opens a `<select>` as a GTK menu: a second X window with a
 *   pointer grab. Gamescope shows one window per app and routes touch to it, so the menu opened
 *   and closed under the finger, or took many taps to choose from (Hachidori's Section list,
 *   Yomitan's settings). Here the list opens inside the page instead, with rows sized for a
 *   finger, and reports the choice with the same `input` and `change` events.
 * - **The on-screen keyboard.** Nothing tells Steam that a text field was tapped. A tap on one
 *   asks native to show Steam's keyboard (`gaming_keyboard_show`), with where the field is on
 *   screen so Steam can keep it in view; so does a field that takes the focus just after a tap
 *   (a button that opens one). A frame that cannot reach native (an extension's own origin)
 *   passes the request to its parent.
 *
 * `window.__kimochiGamingInput` holds the parts, for scripts/gaming-input.test.mjs.
 */
;(function (win) {
  'use strict'

  const KEYBOARD_MESSAGE = '__kimochiGamingKeyboard'
  /** How long after a tap a field taking the focus still counts as that tap's doing. */
  const FOCUS_AFTER_TAP_MS = 1000
  /** `<input>` types that take typed text. */
  const TEXT_TYPES = new Set(['', 'text', 'search', 'url', 'email', 'password', 'number', 'tel'])

  // ----- drop-down lists -------------------------------------------------------------

  /** A `<select>` the platform would open as a pop-up menu (not a list box, not disabled). */
  function isDropdown(element) {
    return !!element && element.localName === 'select' && !element.multiple && !(element.size > 1) && !element.disabled
  }

  /** The rows of `select`, in order: `{group}` headings and `{index, label, disabled, selected}`. */
  function pickerRows(select) {
    const rows = []
    const option = (element, groupDisabled) => {
      if (element.hidden) return
      rows.push({
        index: element.index,
        label: element.label || element.textContent || '',
        disabled: groupDisabled || !!element.disabled,
        selected: element.index === select.selectedIndex
      })
    }
    for (const child of select.children) {
      if (child.localName === 'option') option(child, false)
      else if (child.localName === 'optgroup' && !child.hidden) {
        rows.push({ group: child.label || '' })
        for (const inner of child.children) if (inner.localName === 'option') option(inner, !!child.disabled)
      }
    }
    return rows
  }

  /** Choose option `index`, telling the page as a user's choice does. False when unchanged. */
  function choose(select, index) {
    if (select.selectedIndex === index) return false
    select.selectedIndex = index
    const Event = select.ownerDocument.defaultView.Event
    select.dispatchEvent(new Event('input', { bubbles: true }))
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  }

  /** The next enabled option row from `from` in direction `step`, or `from` when there is none. */
  function nextRow(rows, from, step) {
    for (let at = from + step; at >= 0 && at < rows.length; at += step) {
      if (rows[at].index !== undefined && !rows[at].disabled) return at
    }
    return from
  }

  const PICKER_CSS = `
    :host { all: initial; }
    .backdrop { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center;
      justify-content: center; background: rgb(0 0 0 / 0.45); font: 16px/1.3 system-ui, sans-serif;
      touch-action: none; }
    .list { box-sizing: border-box; min-width: min(280px, 90vw); max-width: 90vw; max-height: 84vh;
      overflow-y: auto; overscroll-behavior: contain; touch-action: pan-y; padding: 6px;
      border-radius: 12px; background: Canvas; color: CanvasText;
      box-shadow: 0 12px 40px rgb(0 0 0 / 0.45); border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }
    .group { padding: 10px 14px 4px; font-size: 13px; font-weight: 600; opacity: 0.65; }
    .row { all: unset; box-sizing: border-box; display: flex; align-items: center; width: 100%;
      min-height: 44px; padding: 8px 14px; border-radius: 8px; cursor: pointer; overflow-wrap: anywhere; }
    .row[aria-selected='true'] { font-weight: 600; background: color-mix(in srgb, CanvasText 10%, transparent); }
    .row.active { outline: 2px solid Highlight; outline-offset: -2px; }
    .row[aria-disabled='true'] { opacity: 0.4; cursor: default; }
  `

  let closePicker = null

  /** Show `select`'s options in the page; resolves nothing, reports through the select's events. */
  function openPicker(select) {
    closePicker?.()
    const doc = select.ownerDocument
    const view = doc.defaultView
    const rows = pickerRows(select)
    const host = doc.createElement('div')
    host.setAttribute('data-kimochi-select-picker', '')
    const root = host.attachShadow({ mode: 'closed' })
    const style = doc.createElement('style')
    style.textContent = PICKER_CSS
    const backdrop = doc.createElement('div')
    backdrop.className = 'backdrop'
    const list = doc.createElement('div')
    list.className = 'list'
    list.setAttribute('role', 'listbox')
    const scheme = view.getComputedStyle?.(select)?.colorScheme
    if (scheme && scheme !== 'normal') list.style.colorScheme = scheme
    const label = select.labels?.[0]?.textContent?.trim() || select.getAttribute('aria-label')
    if (label) list.setAttribute('aria-label', label)

    let active = rows.findIndex((row) => row.selected)
    if (active < 0) active = nextRow(rows, -1, 1)
    const buttons = rows.map((row, at) => {
      const element = doc.createElement('div')
      if (row.group !== undefined) {
        element.className = 'group'
        element.textContent = row.group
      } else {
        element.className = 'row'
        element.setAttribute('role', 'option')
        element.setAttribute('aria-selected', String(row.selected))
        if (row.disabled) element.setAttribute('aria-disabled', 'true')
        // An empty label still needs a row tall enough to tap.
        element.textContent = row.label || ' '
        element.addEventListener('click', (event) => {
          event.stopPropagation()
          if (!row.disabled) finish(at)
        })
      }
      list.append(element)
      return element
    })
    const mark = () => buttons.forEach((button, at) => button.classList?.toggle('active', at === active))
    mark()

    function close() {
      if (closePicker !== close) return
      closePicker = null
      view.removeEventListener('keydown', onKey, true)
      view.removeEventListener('pagehide', close)
      host.remove()
    }
    function finish(at) {
      close()
      choose(select, rows[at].index)
      select.focus?.({ preventScroll: true })
    }
    function onKey(event) {
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
      if (step) {
        active = nextRow(rows, active, step)
        mark()
        buttons[active]?.scrollIntoView?.({ block: 'nearest' })
      } else if (event.key === 'Enter' || event.key === ' ') {
        if (active >= 0 && rows[active] && !rows[active].disabled) finish(active)
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        close()
        select.focus?.({ preventScroll: true })
      } else {
        return
      }
      event.preventDefault()
      event.stopPropagation()
    }
    backdrop.addEventListener('click', () => {
      close()
      select.focus?.({ preventScroll: true })
    })
    list.addEventListener('click', (event) => event.stopPropagation())
    view.addEventListener('keydown', onKey, true)
    view.addEventListener('pagehide', close)

    backdrop.append(list)
    root.append(style, backdrop)
    ;(doc.body ?? doc.documentElement).append(host)
    closePicker = close
    buttons[active]?.scrollIntoView?.({ block: 'center' })
    return close
  }

  function dropdownOf(event) {
    const select = event.target?.closest?.('select')
    return isDropdown(select) ? select : null
  }

  // ----- the on-screen keyboard ------------------------------------------------------

  /** Whether typing goes into `element`: a text input, a text area or editable content. */
  function isTextEntry(element) {
    if (!element || element.disabled || element.readOnly) return false
    if (element.getAttribute?.('inputmode') === 'none') return false
    if (element.localName === 'textarea') return true
    if (element.localName === 'input') return TEXT_TYPES.has(String(element.type ?? '').toLowerCase())
    return !!element.isContentEditable
  }

  /** The text field a tap on `target` lands in, if any. */
  function textEntryOf(target) {
    const field = target?.closest?.('input, textarea, [contenteditable]')
    if (isTextEntry(field)) return field
    return isTextEntry(target) ? target : null
  }

  /** `rect` (within a frame's viewport) as its place in the parent's viewport, given the frame's own rect. */
  function inParent(rect, frame) {
    return { ...rect, x: rect.x + frame.x, y: rect.y + frame.y }
  }

  /**
   * Ask for the keyboard for a field at `rect` (CSS pixels in this frame's viewport). The top
   * frame tells native, as fractions of its viewport: a Gaming Mode window fills the screen, so
   * native needs no zoom or scale from here. A child frame hands the request up.
   */
  function requestKeyboard(view, rect) {
    if (view.parent && view.parent !== view) {
      view.parent.postMessage({ [KEYBOARD_MESSAGE]: rect }, '*')
      return
    }
    const invoke = view.__TAURI_INTERNALS__?.invoke
    if (!invoke) return
    const width = view.innerWidth || 1
    const height = view.innerHeight || 1
    const clamp = (value) => Math.min(1, Math.max(0, value))
    Promise.resolve(
      invoke('gaming_keyboard_show', {
        x: clamp(rect.x / width),
        y: clamp(rect.y / height),
        width: clamp(rect.width / width),
        height: clamp(rect.height / height),
        multiline: !!rect.multiline
      })
    ).catch(() => undefined)
  }

  /** A request passed up from a child frame: place it by that frame's element, then pass it on. */
  function relayKeyboard(view, event) {
    const rect = event.data?.[KEYBOARD_MESSAGE]
    if (!rect || typeof rect.x !== 'number' || typeof rect.y !== 'number') return
    let frame = { x: 0, y: 0 }
    for (const element of view.document.querySelectorAll('iframe, frame')) {
      if (element.contentWindow === event.source) {
        const box = element.getBoundingClientRect()
        frame = { x: box.left + (element.clientLeft || 0), y: box.top + (element.clientTop || 0) }
        break
      }
    }
    requestKeyboard(view, inParent(rect, frame))
  }

  // ----- installation ----------------------------------------------------------------

  function install(view) {
    if (view.__kimochiGamingInputInstalled) return
    view.__kimochiGamingInputInstalled = true
    // The platform opens its menu on the press. Stopping that leaves the click, which opens ours
    // once the finger is up: a list opened on the press would take the same tap's release.
    view.addEventListener(
      'mousedown',
      (event) => {
        if (event.button === 0 && dropdownOf(event)) event.preventDefault()
      },
      true
    )
    const askFor = (field) => {
      const box = field.getBoundingClientRect()
      requestKeyboard(view, {
        x: box.left,
        y: box.top,
        width: box.width,
        height: box.height,
        multiline: field.localName === 'textarea' || !!field.isContentEditable
      })
    }
    let tappedAt = -Infinity
    view.addEventListener(
      'click',
      (event) => {
        tappedAt = Date.now()
        const select = dropdownOf(event)
        if (select) {
          select.focus?.({ preventScroll: true })
          openPicker(select)
          return
        }
        const field = textEntryOf(event.target)
        if (field) askFor(field)
      },
      true
    )
    // A tap on a button that opens a field and puts the caret in it (Add a note, Rename) is a
    // tap to type too. A field the page focuses by itself, with no tap, is not.
    view.addEventListener(
      'focusin',
      (event) => {
        if (Date.now() - tappedAt > FOCUS_AFTER_TAP_MS) return
        const field = textEntryOf(event.target)
        if (field) askFor(field)
      },
      true
    )
    view.addEventListener(
      'keydown',
      (event) => {
        if (closePicker) return
        const opens =
          event.key === ' ' ||
          event.key === 'Enter' ||
          event.key === 'F4' ||
          (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp'))
        const select = opens ? dropdownOf(event) : null
        if (!select) return
        event.preventDefault()
        openPicker(select)
      },
      true
    )
    view.addEventListener('message', (event) => relayKeyboard(view, event))
  }

  win.__kimochiGamingInput = {
    install,
    isDropdown,
    pickerRows,
    choose,
    nextRow,
    openPicker,
    isTextEntry,
    textEntryOf,
    inParent,
    requestKeyboard
  }
  if (win.__KIMOCHI_PLATFORM__?.gamescope) install(win)
})(window)

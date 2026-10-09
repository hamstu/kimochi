/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Shared DOM controller keyboard. */
const TEXT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password'])

export function supportsControllerKeyboard(element) {
  return (element.tagName === 'TEXTAREA' || (element.tagName === 'INPUT' && TEXT_TYPES.has(element.type || 'text'))) &&
    !element.disabled && !element.readOnly && !element.hasAttribute('data-controller-keyboard-input')
}

/** Edit UTF-16 DOM selections, preserving complete characters when deleting. */
export function editKeyboardBuffer(state, action) {
  const value = state.value
  const start = Math.max(0, Math.min(value.length, state.start))
  const end = Math.max(start, Math.min(value.length, state.end))
  let from = start, to = end, text = ''
  if (action.type === 'insert') text = action.text
  else if (action.type === 'backspace') {
    if (from === to && from > 0) from -= [...value.slice(0, from)].at(-1).length
  } else if (action.type === 'delete') {
    if (from === to && to < value.length) to += [...value.slice(to)][0].length
  } else if (action.type === 'left' || action.type === 'right') {
    const caret = action.type === 'left'
      ? (start !== end ? start : Math.max(0, start - ([...value.slice(0, start)].at(-1)?.length ?? 0)))
      : (start !== end ? end : Math.min(value.length, end + ([...value.slice(end)][0]?.length ?? 0)))
    return { value, start: caret, end: caret }
  } else return { value, start, end }
  const next = value.slice(0, from) + text + value.slice(to)
  return { value: next, start: from + text.length, end: from + text.length }
}

/** Use native accessors so React's value tracker observes the subsequent input event. */
export function commitKeyboardValue(element, value) {
  if (element.value === value) return false
  const win = element.ownerDocument.defaultView
  const prototype = element.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (setter) setter.call(element, value)
  else element.value = value
  element.dispatchEvent(new win.Event('input', { bubbles: true }))
  element.dispatchEvent(new win.Event('change', { bubbles: true }))
  return true
}

/** App-owned dialog; original value changes only on Done. Physical input and touch stay native. */
export function openControllerKeyboard(target, onClose = () => {}) {
  const doc = target.ownerDocument
  const originalFocus = doc.activeElement
  const dialog = doc.createElement('div')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', 'Controller keyboard')
  dialog.dataset.controllerKeyboard = ''
  const style = doc.createElement('style')
  style.textContent = `
[data-controller-keyboard] { position: fixed; inset: 0; z-index: 2147483647; background: rgb(0 0 0 / .6); display: flex; align-items: center; justify-content: center; padding: 12px; box-sizing: border-box; }
[data-controller-keyboard] .ck-body { width: min(680px, 100%); max-height: 100%; overflow: auto; border-radius: 12px; padding: 16px; background: #20242c; color: #fafafa; font: 16px system-ui; box-shadow: 0 8px 36px #0008; }
[data-controller-keyboard] .ck-title { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
[data-controller-keyboard] .ck-hint { font-size: 12px; color: #bdc5d5; margin: 8px 0; }
[data-controller-keyboard] .ck-editor { box-sizing: border-box; width: 100%; min-height: 44px; font: inherit; padding: 8px; background: #10131a; border: 1px solid #788399; color: inherit; border-radius: 6px; }
[data-controller-keyboard] .ck-row { display: flex; justify-content: center; gap: 4px; margin-top: 5px; }
[data-controller-keyboard] button { flex: 1; min-width: 0; min-height: 36px; padding: 6px 3px; font: inherit; background: #343c49; color: inherit; border: 1px solid #66738a; border-radius: 5px; cursor: pointer; }
[data-controller-keyboard] button:focus { outline: 3px solid #78aaff !important; outline-offset: 0; background: #435b82; }
[data-controller-keyboard] [data-ck-wide] { flex: 2; }
`
  const body = doc.createElement('div')
  body.className = 'ck-body'
  const title = doc.createElement('p')
  title.className = 'ck-title'
  title.textContent = 'Controller keyboard'
  const hint = doc.createElement('p')
  hint.className = 'ck-hint'
  hint.textContent = 'A: select · B: cancel · Done: apply. Japanese IME uses a physical or system keyboard.'
  const editor = doc.createElement(target.tagName === 'TEXTAREA' ? 'textarea' : 'input')
  editor.className = 'ck-editor'
  editor.setAttribute('data-controller-keyboard-input', '')
  editor.setAttribute('aria-label', target.getAttribute('aria-label') || target.placeholder || 'Edit text')
  if (editor.tagName === 'INPUT') editor.type = target.type === 'password' ? 'password' : 'text'
  editor.value = target.value
  editor.autocomplete = 'off'
  editor.spellcheck = false
  if (target.maxLength >= 0) editor.maxLength = target.maxLength
  body.append(title, editor, hint)
  dialog.append(style, body)
  let closed = false
  let shifted = false
  const characterButtons = []
  const state = () => ({ value: editor.value, start: editor.selectionStart ?? editor.value.length, end: editor.selectionEnd ?? editor.value.length })
  const edit = (action) => {
    const next = editKeyboardBuffer(state(), action)
    if (target.maxLength >= 0 && next.value.length > target.maxLength && next.value.length > editor.value.length) return
    editor.value = next.value
    editor.setSelectionRange(next.start, next.end)
  }
  const close = (commit = false) => {
    if (closed) return
    closed = true
    if (commit) commitKeyboardValue(target, editor.value)
    dialog.remove()
    doc.removeEventListener('keydown', onKey, true)
    const focus = target.isConnected ? target : originalFocus
    if (focus?.isConnected) focus.focus({ preventScroll: true })
    onClose()
  }
  const button = (row, text, action, wide = false) => {
    const element = doc.createElement('button')
    element.type = 'button'
    element.textContent = text
    if (wide) element.setAttribute('data-ck-wide', '')
    element.addEventListener('click', action)
    row.append(element)
    return element
  }
  for (const chars of ['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm', '@./:-_?&=+']) {
    const row = doc.createElement('div')
    row.className = 'ck-row'
    for (const char of chars) {
      const element = button(row, char, () => edit({ type: 'insert', text: shifted ? char.toUpperCase() : char }))
      characterButtons.push({ element, char })
    }
    body.append(row)
  }
  const row = doc.createElement('div')
  row.className = 'ck-row'
  const shift = button(row, 'Shift', () => {
    shifted = !shifted
    shift.setAttribute('aria-pressed', String(shifted))
    for (const { element, char } of characterButtons) element.textContent = shifted ? char.toUpperCase() : char
  })
  shift.setAttribute('aria-pressed', 'false')
  button(row, 'Space', () => edit({ type: 'insert', text: ' ' }), true)
  button(row, '⌫', () => edit({ type: 'backspace' })).setAttribute('aria-label', 'Backspace')
  button(row, '←', () => edit({ type: 'left' })).setAttribute('aria-label', 'Move caret left')
  button(row, '→', () => edit({ type: 'right' })).setAttribute('aria-label', 'Move caret right')
  if (target.tagName === 'TEXTAREA') button(row, '↵', () => edit({ type: 'insert', text: '\n' })).setAttribute('aria-label', 'New line')
  body.append(row)
  const actions = doc.createElement('div')
  actions.className = 'ck-row'
  button(actions, 'Done', () => close(true), true)
  const cancel = button(actions, 'Cancel', () => close(false), true)
  cancel.setAttribute('data-modal-action', 'hide')
  body.append(actions)
  const onKey = (event) => {
    if (!dialog.contains(doc.activeElement)) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(false) }
    else if (event.key === 'Tab') {
      const stops = [editor, ...dialog.querySelectorAll('button')]
      const index = stops.indexOf(doc.activeElement)
      event.preventDefault()
      stops[(index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length].focus()
    }
  }
  doc.body.append(dialog)
  doc.addEventListener('keydown', onKey, true)
  characterButtons[0].element.focus({ preventScroll: true })
  try { editor.setSelectionRange(target.selectionStart ?? target.value.length, target.selectionEnd ?? target.value.length) } catch { /* Some text-like input types have no selection API. */ }
  return { close, editor, dialog }
}

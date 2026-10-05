/**
 * Tauri accelerator strings (`CommandOrControl+Shift+8`) as key caps, and key events back into
 * accelerators. Pure functions so `scripts/accelerator.test.mjs` can exercise them.
 */

export type KeyPlatform = 'mac' | 'windows' | 'linux'

/** The parts of `PlatformCapabilities` key handling reads; structural so this module stays pure. */
export interface KeyCapabilities {
  os: 'macos' | 'windows' | 'linux'
  keys: { primaryModifier: 'meta' | 'ctrl' }
}

/**
 * Platform for key labels and recording, from the platform capabilities: macOS gets ⌘ ⇧ ⌥ ⌃
 * symbols, Windows Ctrl / Shift / Alt / Win and Linux Ctrl / Shift / Alt / Super words.
 */
export function keyPlatformOf(capabilities: Pick<KeyCapabilities, 'os'>): KeyPlatform {
  return capabilities.os === 'macos' ? 'mac' : capabilities.os === 'windows' ? 'windows' : 'linux'
}

/**
 * True when only the platform's primary modifier is held: ⌘ on macOS (Ctrl does not count), Ctrl
 * elsewhere. App shortcuts such as ⌘1 / Ctrl+1 use it.
 */
export function isPrimaryModifier(
  event: Pick<KeyComboEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  capabilities: KeyCapabilities
): boolean {
  if (event.altKey || event.shiftKey) return false
  return capabilities.keys.primaryModifier === 'meta'
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
}

type Modifier = 'control' | 'alt' | 'shift' | 'command' | 'commandOrControl' | 'altGr'

const MODIFIER_TOKENS: Record<string, Modifier> = {
  commandorcontrol: 'commandOrControl',
  cmdorctrl: 'commandOrControl',
  command: 'command',
  cmd: 'command',
  super: 'command',
  meta: 'command',
  control: 'control',
  ctrl: 'control',
  alt: 'alt',
  option: 'alt',
  altgr: 'altGr',
  shift: 'shift'
}

const MODIFIER_LABELS: Record<KeyPlatform, Record<Modifier, string>> = {
  mac: { control: '⌃', alt: '⌥', shift: '⇧', command: '⌘', commandOrControl: '⌘', altGr: '⌥' },
  windows: { control: 'Ctrl', alt: 'Alt', shift: 'Shift', command: 'Win', commandOrControl: 'Ctrl', altGr: 'AltGr' },
  linux: { control: 'Ctrl', alt: 'Alt', shift: 'Shift', command: 'Super', commandOrControl: 'Ctrl', altGr: 'AltGr' }
}

/** Display order: macOS's ⌃⌥⇧⌘; elsewhere Ctrl, Win/Super, Alt, Shift. */
const WORD_ORDER: Modifier[] = ['commandOrControl', 'control', 'command', 'alt', 'altGr', 'shift']
const MODIFIER_ORDER: Record<KeyPlatform, Modifier[]> = {
  mac: ['control', 'alt', 'altGr', 'shift', 'command', 'commandOrControl'],
  windows: WORD_ORDER,
  linux: WORD_ORDER
}

const KEY_LABELS: Record<string, { mac: string; other: string }> = {
  up: { mac: '↑', other: '↑' },
  arrowup: { mac: '↑', other: '↑' },
  down: { mac: '↓', other: '↓' },
  arrowdown: { mac: '↓', other: '↓' },
  left: { mac: '←', other: '←' },
  arrowleft: { mac: '←', other: '←' },
  right: { mac: '→', other: '→' },
  arrowright: { mac: '→', other: '→' },
  space: { mac: 'Space', other: 'Space' },
  enter: { mac: '↩', other: 'Enter' },
  return: { mac: '↩', other: 'Enter' },
  tab: { mac: '⇥', other: 'Tab' },
  backspace: { mac: '⌫', other: 'Backspace' },
  delete: { mac: '⌦', other: 'Del' },
  escape: { mac: 'Esc', other: 'Esc' },
  esc: { mac: 'Esc', other: 'Esc' },
  insert: { mac: 'Ins', other: 'Ins' },
  home: { mac: 'Home', other: 'Home' },
  end: { mac: 'End', other: 'End' },
  pageup: { mac: 'PgUp', other: 'PgUp' },
  pagedown: { mac: 'PgDn', other: 'PgDn' },
  plus: { mac: '+', other: '+' }
}

/** Split an accelerator into tokens; an empty token (from `++` or a trailing `+`) is the plus key. */
function tokens(accelerator: string): string[] {
  const parts = accelerator.split('+').map((part) => part.trim())
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== '') out.push(parts[i])
    else if (i > 0 && parts[i - 1] !== '') {
      out.push('Plus')
      i++ // `A++` splits as ['A', '', ''] — one plus key.
    }
  }
  return out
}

function keyLabel(token: string, platform: KeyPlatform): string {
  const lower = token.toLowerCase()
  const known = KEY_LABELS[lower]
  if (known) return known[platform === 'mac' ? 'mac' : 'other']
  const letter = /^key([a-z])$/i.exec(token)
  if (letter) return letter[1].toUpperCase()
  const digit = /^(?:digit|num|numpad)(\d)$/i.exec(token)
  if (digit) return digit[1]
  if (/^f\d{1,2}$/i.test(token)) return token.toUpperCase()
  if (token.length === 1) return token.toUpperCase()
  return token
}

/** The key caps for an accelerator, modifiers first, e.g. ['⇧', '⌘', '8'] on macOS. */
export function acceleratorCaps(accelerator: string, platform: KeyPlatform): string[] {
  const modifiers = new Set<Modifier>()
  const keys: string[] = []
  for (const token of tokens(accelerator)) {
    const modifier = MODIFIER_TOKENS[token.toLowerCase()]
    if (modifier) modifiers.add(modifier)
    else keys.push(keyLabel(token, platform))
  }
  const labels = MODIFIER_ORDER[platform]
    .filter((modifier) => modifiers.has(modifier))
    .map((modifier) => MODIFIER_LABELS[platform][modifier])
  return [...new Set(labels), ...keys]
}

/** A readable one-line form (`⇧⌘8` on macOS, `Ctrl+Shift+8` elsewhere) for text and labels. */
export function formatAccelerator(accelerator: string, platform: KeyPlatform): string {
  return acceleratorCaps(accelerator, platform).join(platform === 'mac' ? '' : '+')
}

export interface KeyComboEvent {
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

const PUNCTUATION_CODES: Record<string, string> = {
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

const NAMED_CODES: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  NumpadAdd: 'Plus',
  ...PUNCTUATION_CODES
}

const MODIFIER_KEYS = new Set(['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'OS', 'Hyper', 'Super', 'CapsLock', 'Fn'])

/** True while only modifiers are held (keep recording and wait for the actual key). */
export function isModifierOnly(event: Pick<KeyComboEvent, 'key'>): boolean {
  return MODIFIER_KEYS.has(event.key)
}

/** The accelerator key token for a physical key, or null when it cannot be a shortcut key. */
function keyToken(event: KeyComboEvent): string | null {
  const { code, key } = event
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1]
  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]
  const numpad = /^Numpad(\d)$/.exec(code)
  if (numpad) return `Num${numpad[1]}`
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code
  if (NAMED_CODES[code]) return NAMED_CODES[code]
  // No usable code (synthetic events): fall back to the key value.
  if (/^[a-z]$/i.test(key)) return key.toUpperCase()
  if (/^\d$/.test(key)) return key
  if (/^F([1-9]|1\d|2[0-4])$/.test(key)) return key
  return null
}

/**
 * The Tauri accelerator for a key press, or null when it is not a usable global shortcut: the key
 * must be a function key, or come with Command / Control / Alt (Shift alone would swallow typing).
 * ⌘ on macOS and Ctrl elsewhere become `CommandOrControl`.
 */
export function acceleratorFromEvent(event: KeyComboEvent, platform: KeyPlatform): string | null {
  if (isModifierOnly(event)) return null
  const key = keyToken(event)
  if (!key) return null
  const parts: string[] = []
  if (platform === 'mac') {
    if (event.metaKey) parts.push('CommandOrControl')
    if (event.ctrlKey) parts.push('Control')
  } else {
    if (event.ctrlKey) parts.push('CommandOrControl')
    if (event.metaKey) parts.push('Super')
  }
  if (event.altKey) parts.push('Alt')
  const hasModifier = parts.length > 0
  if (event.shiftKey) parts.push('Shift')
  if (!hasModifier && !/^F\d+$/.test(key)) return null
  return [...parts, key].join('+')
}

/** Caps for the modifiers currently held, shown live while recording. */
export function heldModifierCaps(event: Omit<KeyComboEvent, 'key' | 'code'>, platform: KeyPlatform): string[] {
  const parts: string[] = []
  if (platform === 'mac') {
    if (event.metaKey) parts.push('CommandOrControl')
    if (event.ctrlKey) parts.push('Control')
  } else {
    if (event.ctrlKey) parts.push('CommandOrControl')
    if (event.metaKey) parts.push('Super')
  }
  if (event.altKey) parts.push('Alt')
  if (event.shiftKey) parts.push('Shift')
  return parts.length ? acceleratorCaps(parts.join('+'), platform) : []
}

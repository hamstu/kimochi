/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS runtime glue. */
/**
 * The overlay's view of the native layer.
 *
 * Every Rust command goes through here rather than being invoked inline, for two
 * reasons. Commands that kimochi-native has not shipped yet degrade to a single
 * reported gap instead of an exception on every poll tick, and the set of
 * capabilities the overlay is actually running with becomes inspectable — so a
 * missing texthooker or relay shows up as a stated limitation rather than as
 * silence.
 */

import { SETTINGS_DEFAULTS, withDefaults } from './settings.js'
import { fallbackCapabilities, normalizeCapabilities } from './capabilities.js'

const tauri = globalThis.__TAURI__
const core = tauri?.core
const events = tauri?.event

/** Commands found to be absent, so each one is reported once, not every tick. */
const missing = new Set()
const listeners = new Set()

function notifyCapabilityGap(command, error) {
  if (missing.has(command)) return
  missing.add(command)
  for (const listener of listeners) listener(command, error)
}

/** Tauri reports an unregistered command by name; anything else is a real error. */
function isMissingCommand(error) {
  return /not (?:found|allowed)|unknown command|Command .* not/i.test(
    String(error?.message ?? error)
  )
}

/**
 * Invoke a command, returning `fallback` if native does not implement it.
 * Genuine runtime failures still throw — a capture permission error must not be
 * mistaken for a missing command.
 */
export async function optional(command, args, fallback = null) {
  if (!core) return fallback
  if (missing.has(command)) return fallback
  try {
    return await core.invoke(command, args)
  } catch (error) {
    if (isMissingCommand(error)) {
      notifyCapabilityGap(command, error)
      return fallback
    }
    throw error
  }
}

export function invoke(command, args) {
  if (!core) return Promise.reject(new Error('Tauri core API unavailable'))
  return core.invoke(command, args)
}

export function onCapabilityGap(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function unavailableCommands() {
  return [...missing]
}

export async function listen(event, handler) {
  if (!events?.listen) return () => {}
  try {
    return await events.listen(event, handler)
  } catch {
    return () => {}
  }
}

// --- settings ---------------------------------------------------------------

let cache = null

/** One round trip at boot; afterwards the cache is kept fresh by the event. */
export async function loadSettings() {
  const all = await optional('settings_all', undefined, null)
  cache = all && typeof all === 'object' ? all : {}
  return cache
}

export function getSetting(key) {
  return withDefaults(key, cache?.[key])
}

export async function setSetting(key, value) {
  if (cache) cache[key] = value
  await optional('settings_set', { key, value })
}

/**
 * Track cross-window settings changes. Falls back to a slow poll only if the
 * event is unavailable, so a panel toggling live overlay still reaches us.
 */
export async function watchSettings(onChange) {
  await loadSettings()
  const stop = await listen('settings:changed', ({ payload }) => {
    if (!payload || typeof payload.key !== 'string') return
    if (cache) cache[payload.key] = payload.value
    onChange(payload.key, withDefaults(payload.key, payload.value))
  })
  return stop
}

export function settingsKeys() {
  return Object.keys(SETTINGS_DEFAULTS)
}

// --- platform capabilities -------------------------------------------------

let capabilitiesRequest = null

/**
 * What this machine can do (`platform_capabilities`), asked once and cached.
 *
 * Never rejects: a backend without the command, or no backend at all, yields
 * the macOS default — today's behaviour — so nothing regresses while native
 * catches up. `watchCapabilities` follows later re-emits.
 */
export function capabilities() {
  capabilitiesRequest ??= optional('platform_capabilities', undefined, null)
    .catch(() => null)
    .then((raw) => normalizeCapabilities(raw, fallbackCapabilities()))
  return capabilitiesRequest
}

/** Call `onChange` with the capabilities now and again whenever native re-sends them. */
export async function watchCapabilities(onChange) {
  let pushed = false
  const stop = await listen('platform-capabilities', ({ payload }) => {
    const next = normalizeCapabilities(payload, fallbackCapabilities())
    capabilitiesRequest = Promise.resolve(next)
    pushed = true
    onChange(next)
  })
  const initial = await capabilities()
  // A re-emit that landed while the first answer was in flight is newer.
  if (!pushed) onChange(initial)
  return stop
}

// --- capture and OCR --------------------------------------------------------

/**
 * Capture the selected source without touching the network.
 *
 * The auto-scan probe: cheap, and it leaves the shared view alone so a probe
 * every few hundred milliseconds cannot force the overlay to re-render.
 *
 * With `observe`, the same native call also returns a perceptual hash of the
 * captured pixels and whatever the local text observer read from them. One round
 * trip, and — the point — no second trip back through the `capture:` protocol to
 * fetch the PNG and hash it in a canvas. That second trip is where the recorded
 * `Load failed` errors came from, though not which part of it threw.
 */
export function captureFrame(request, observe = false, observerMode = 'text') {
  return invoke('capture_frame', { request, observe, observerMode })
}

/**
 * Keep a settling candidate's frame alive, or let it go.
 *
 * The native store holds the newest frame and the published one. A candidate
 * being watched over several observations is neither, so without this the frame
 * a decision was made about is evicted by the very probes that made it.
 */
export async function retainFrame(id, retain) {
  const held = await invoke('retain_frame', { id, retain: !!retain })
  if (retain && held !== true) throw new Error('gone: captured frame could not be retained')
  return held
}

/**
 * What the local text observer can do on this machine.
 *
 * Asked once, so a platform without one can say so plainly rather than
 * discovering it one failed tick at a time.
 */
export const observerStatus = () =>
  optional('observer_status', undefined, {
    supported: false,
    engine: 'none',
    detail: 'This build has no local text observer.',
    timeouts: 0
  })

/**
 * Recognise a frame that has already been captured.
 *
 * Always the frame the gate hashed, never a fresh one. Recapturing would send a
 * different image than the one compared, and pair the returned text with
 * geometry belonging to a frame nobody looked at.
 */
export async function ocrFrame(frame, engine = 'cloud') {
  const result = await invoke('ocr_frame', { id: frame?.id, engine })
  return result ? { ocr: result.ocr ?? null, id: result.id ?? frame?.id ?? null } : null
}

export const clearScan = () => optional('clear')
export const desktop = () => invoke('desktop')
/** Displays with their backing scale, which converts points to capture pixels. */
export const displays = () => invoke('displays')
/** Atomic selection + crop, keyed per source descriptor by native. */
export const commitSource = (sourceId, crop) => invoke('commit_source', { sourceId, crop, keepCrop: false })
/** The main window, with its source menu open on the grid of windows and displays. */
export const openSourcePicker = () => invoke('open_source_picker')
export const preferences = () => invoke('preferences')
export const selectedSource = () => optional('selected_source', undefined, null)
/**
 * The whole window, full resolution, from a slot of its own (`{url, width, height,
 * scaleFactor}`), for the hover outline. Never a scan frame: it cannot evict or
 * replace anything a scan or the auto loop holds, and it refuses with `busy:`
 * while one is capturing.
 */
export const sourceHoverPreview = (sourceId) =>
  optional('source_hover_preview', { sourceId }, null)
export const placeOverlay = (rect) => invoke('place_overlay', { rect })
/** The display under the pointer (`{id, bounds, scale_factor}`), where a Quick Shot is drawn. */
export const pointerDisplay = () => invoke('pointer_display')
/** The pointer in desktop points and the display under it: `{x, y, display}`, or null. */
export const pointerLocation = () => optional('pointer_location', {}, null)
/**
 * Escape and Return as global shortcuts while the region editor is open (`region-key` events):
 * the overlay never holds the keyboard, so this is how they reach it.
 */
export const regionKeys = (on) => optional('region_keys', { on })
/**
 * Controller mode on or off. On: native stops dispatching gamepad bindings and reports raw
 * input as `controller-nav` events, reports the arrow keys, Return and Escape as
 * `controller-key` events, and takes focus from the game. Off: all of that is undone and the
 * game gets its focus back.
 */
export const controllerNav = (active) => invoke('controller_nav', { active })
/** Every action's shortcut and gamepad binding, defaults merged with the user's. */
export const hotkeysLoad = () => optional('hotkeys_load', undefined, null)
export const setRegions = (rects) => invoke('regions', { rects })
export const snapshot = () => invoke('snapshot')
export const panel = (label, action, rect = null) => invoke('panel', { label, action, rect })
export const setDictionaryOpen = (open) => optional('dictionary', { open })
export const report = (value) => optional('report', { value })

/** Fire the same path a global shortcut takes, from the gamepad or a panel. */
export const triggerAction = (name) => optional('trigger_action', { name })

/** Clipboard plus the texthooker WebSocket server, both of which must be native. */
export const publishText = (text) => optional('texthooker_send', { text })

/**
 * Publish scan lifecycle to the shared view.
 *
 * `capture_frame` is deliberately pure and `ocr_frame` only publishes what it
 * recognised itself, so the browser-side pipeline has to say when it is working,
 * what went wrong, and — for the text-only backends, which never call
 * `ocr_frame` — what it produced. Without this the controller's status and
 * scanning indicator, and the capture and debug panels, stay blank for every
 * scan this window drives.
 *
 * Every field is optional and an omitted field leaves its state untouched, so a
 * mid-scan status update does not bump the revision and force every window to
 * re-render. `publish: true` replaces `view.scan` and bumps the revision; native
 * ignores a repeated publish of the same frame id.
 *
 * @param {{scanning?: boolean, status?: string, scan?: object|null, publish?: boolean}} update
 */
export const publishScanState = (update) => invoke('scan_state', update)

/**
 * Session view flags (auto-OCR running, overlay text shown, debug panels).
 * These live on the shared native view, not in settings, so the controller and
 * the overlay cannot disagree about what is currently on.
 */
export const setViewFlags = (flags) => optional('view_flags', { flags })

/**
 * Track the selected source's bounds between scans, so the overlay follows a
 * window that moves or changes display without waiting for the next capture.
 */
export const watchSource = (sourceId) => optional('watch_source', { sourceId })

/** Bidirectional JSON between window labels; carries the Yomitan relay. */
export const relay = (target, payload) => optional('ext_relay', { target, payload })

/** The URL the `capture:` protocol serves a captured frame's PNG from. */
export function frameUrl(frame) {
  if (frame?.url) return frame.url
  const id = frame?.id
  if (id === undefined || id === null) return null
  return core?.convertFileSrc ? core.convertFileSrc(String(id), 'capture') : null
}

/** Batched bounded diagnostic sink; it does not feed panel state broadcasts. */
export const writeScanTrace = (records) => invoke('scan_trace', { records })

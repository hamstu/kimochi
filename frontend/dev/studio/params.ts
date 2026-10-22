/**
 * DEV-ONLY: the UI studio's state and the frame URL it makes. The studio keeps a value for every
 * control the reader has touched; the frame's URL carries the surface's fixed parameters, the top
 * bar's, the reader's context (a settings page, a welcome step) and those values.
 */
import type { Control, ContextAxis, StudioContext, Surface } from './types'

/** Parameter values chosen per surface (absent: the page's default). */
export type Values = Record<string, string>

export function axesOf(surface: Surface): readonly ContextAxis[] {
  if (!surface.contexts) return []
  return Array.isArray(surface.contexts) ? surface.contexts : [surface.contexts as ContextAxis]
}

/** The axes that apply in `context`, each with the option it is on. */
export function activeAxes(surface: Surface, context: StudioContext): { axis: ContextAxis; value: string }[] {
  return axesOf(surface)
    .filter((axis) => !axis.when || axis.when(context))
    .map((axis) => ({ axis, value: context[axis.param] ?? axis.options[0]?.value ?? '' }))
}

/** What the page is sent without the reader asking: the surface's fixed parameters, and what the context needs. */
export function impliedParams(surface: Surface, context: StudioContext): Values {
  const implied: Values = { ...surface.params }
  for (const { axis, value } of activeAxes(surface, context))
    Object.assign(implied, axis.options.find((o) => o.value === value)?.params)
  return implied
}

/**
 * A stored value of '' means "the page's default, deliberately": the parameter is left out even
 * where the context would send one (turning off Screen Recording's "not granted" on its own step).
 */
const ABSENT = ''

/** What a control shows: the reader's value, else the implied one, else the page's default. */
export function controlValue(control: Control, values: Values, implied: Values): string {
  const stored = values[control.param]
  const chosen = stored === ABSENT ? undefined : (stored ?? implied[control.param])
  if (control.kind === 'select') return chosen ?? control.default
  if (control.kind === 'toggle') {
    if (chosen === undefined) return control.default ? control.on : (control.off ?? '')
    return chosen
  }
  return chosen ?? ''
}

/**
 * The value to keep for a control set to `value`: undefined when the page gets that without it
 * (its default, or what the context implies), '' when the context would send something else.
 */
export function storedValue(control: Control, value: string, implied: Values = {}): string | undefined {
  let wanted: string | undefined
  if (control.kind === 'select') wanted = value === control.default ? undefined : value
  else if (control.kind === 'toggle') {
    const on = value === control.on
    wanted = on === Boolean(control.default) ? undefined : on ? control.on : control.off
  } else wanted = value === '' ? undefined : value
  const given = implied[control.param]
  if (wanted === given) return undefined
  return wanted ?? ABSENT
}

export function frameUrl(surface: Surface, globals: Values, context: StudioContext, values: Values): string {
  const query = new URLSearchParams({ ...surface.params })
  const absent = new Set<string>()
  const put = (key: string, value: string): void => {
    if (value === ABSENT) {
      query.delete(key)
      absent.add(key)
    } else query.set(key, value)
  }
  for (const [key, value] of Object.entries(globals)) put(key, value)
  for (const { axis, value } of activeAxes(surface, context)) query.set(axis.param, value)
  for (const [key, value] of Object.entries(values)) put(key, value)
  for (const [key, v] of Object.entries(impliedParams(surface, context)))
    if (!query.has(key) && !absent.has(key)) query.set(key, v)
  // The macOS default: drop it so the page's own default reads plainly in the URL.
  if (query.get('platform') === 'macos') query.delete('platform')
  return `/dev/${surface.page}?${query}`
}

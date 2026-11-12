/**
 * Where a controller axis rests, so the button test does not show a resting trigger as input.
 * Mirrors `axis_rest` / `away_from_rest` in src-tauri/src/gamepad.rs: a trigger or pedal often
 * rests at an end (-1), a stick near 0.
 */

/** Closer than this to where it rests, an axis is not input. */
export const RAW_AXIS_SHOWN = 0.5

/** The rest an axis has, from the first value seen for it. */
export function axisRest(first: number): number {
  return Number.isFinite(first) && Math.abs(first) >= 0.75 ? Math.sign(first) : 0
}

export function awayFromRest(value: number, rest: number): boolean {
  return Number.isFinite(value) && Math.abs(value - rest) >= RAW_AXIS_SHOWN
}

/**
 * The axes pushed away from rest, as `rawAxes` entries. `rests` keeps each axis's rest across
 * polls, keyed by the caller (controller and axis index); an axis gets its rest the first time
 * it is seen.
 */
export function axesAwayFromRest(
  axes: readonly number[],
  rests: Map<string, number>,
  key: (index: number) => string
): { code: string; name: null; value: number }[] {
  return axes.flatMap((value, index) => {
    const id = key(index)
    let rest = rests.get(id)
    if (rest === undefined) {
      rest = axisRest(value)
      rests.set(id, rest)
    }
    return awayFromRest(value, rest) ? [{ code: `Axis ${index}`, name: null, value: Math.round(value * 2) / 2 }] : []
  })
}

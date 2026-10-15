/** The state behind `useSteadyValue` (see `ime.ts`), kept free of React so it can be tested. */
export interface Steady<V> {
  /** What the field shows. */
  shown: V
  /** Values typed since the prop last caught up, oldest first. */
  typed: string[]
  /** The value prop last seen. */
  prop: V
}

export const steadyStart = <V>(value: V): Steady<V> => ({ shown: value, typed: [], prop: value })

/** A new value prop: an echo of something typed keeps what the field shows; anything else replaces it. */
export function steadyProp<V>(state: Steady<V>, value: V): Steady<V> {
  if (value === state.prop) return state
  const echo = typeof value === 'string' ? state.typed.indexOf(value) : -1
  return echo >= 0
    ? { shown: state.shown, typed: state.typed.slice(echo + 1), prop: value }
    : { shown: value, typed: [], prop: value }
}

/** The user typed `value`. */
export const steadyTyped = <V>(state: Steady<V>, value: string): Steady<V | string> => ({
  ...state,
  shown: value,
  typed: [...state.typed, value].slice(-64),
})

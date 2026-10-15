/**
 * Japanese (and other IME) input support for every text field.
 *
 * An IME builds text in place before it is committed: romaji turns into kana, then into the chosen
 * kanji. Two things break that: a key handler acting on a key the IME owns (Enter commits the
 * conversion, Escape cancels it, the arrows pick a candidate), and React writing a different value
 * into the field mid-composition, which commits whatever kana was there.
 */
import { useState, type ChangeEvent, type ChangeEventHandler, type KeyboardEvent } from 'react'
import { steadyProp, steadyStart, steadyTyped, type Steady } from './steadyValue'

/**
 * Whether a key press belongs to an IME composition. WebKit reports the key that ends one (Enter,
 * Escape) with `isComposing` false but keyCode 229, so both are checked.
 */
export function isComposing(event: KeyboardEvent | globalThis.KeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event
  return native.isComposing || native.keyCode === 229
}

type Field = HTMLInputElement | HTMLTextAreaElement

/**
 * A controlled field's value, steadied against late echoes. A field saved through an async round
 * trip (the Notebook's, through the session owner) gets each typed value back a moment later, by
 * which time the field holds more; writing that stale value back resets the text under the IME.
 * So the field shows what was typed, a value that echoes something typed earlier is ignored, and
 * any other new value (a reset, a different entry) replaces it.
 */
export function useSteadyValue<E extends Field>(
  value: string | number | readonly string[] | undefined,
  onChange: ChangeEventHandler<E> | undefined
): { value: typeof value; onChange: ChangeEventHandler<E> | undefined } {
  const [state, setState] = useState<Steady<typeof value>>(() => steadyStart(value))
  const current = steadyProp(state, value)
  if (current !== state) setState(current)
  if (typeof value !== 'string') return { value, onChange }
  return {
    value: current.shown,
    onChange: (event: ChangeEvent<E>) => {
      const typed = event.target.value
      setState((s) => steadyTyped(s, typed))
      onChange?.(event)
    },
  }
}

/**
 * The demo's scripted run, as a flat list of frames. Each frame is the complete visible state for
 * `ms` milliseconds; the player steps through them in a loop. Desktop and Steam Deck share the game
 * screen, so they share the frame shape.
 */
import { useEffect, useState } from 'react'
import { PLAY_LINES } from './content'

export type Button = 'L3' | 'R3' | 'up' | 'right' | 'A' | 'B'

/** Read along (the app's controller `words` mode): stepping the text, or in the pop-up's buttons. */
export interface Reading {
  /** `text`: the outline steps word to word; `popup`: A moved into the pop-up's buttons. */
  layer: 'text' | 'popup'
  /** Segmenting the scan: the hint bar says "Reading the text…" and nothing is lit yet. */
  loading?: boolean
}

export interface Frame {
  ms: number
  line: number
  /** Dialogue text: typing in, or fully shown. */
  text: 'typing' | 'shown'
  /** The scan sweep is running. */
  scan: boolean
  /** The overlay's word boxes are up. */
  boxes: boolean
  /** Highlighted token (overlay hover or controller cursor). */
  cursor: number | null
  popup: boolean
  /** The controller's radial menu: closed, or open with a chosen item (-1 none). */
  menu: { sel: number; chosen: boolean } | null
  /** Handheld: Read along is open (outline and hint bar), or null. */
  reading: Reading | null
  /** Buttons held this frame (lit on the handheld's controls). */
  pressed: Button[]
  /** Handheld: the demo's own caption, beside the buttons held (not part of the app). */
  hint: string
  /** Sent to the embedded Log when the frame starts. */
  emit?: 'scan' | 'line'
}

const TYPE_MS = 42

function base(line: number): Omit<Frame, 'ms'> {
  return { line, text: 'shown', scan: false, boxes: false, cursor: null, popup: false, menu: null, reading: null, pressed: [], hint: '' }
}

function typing(line: number): number {
  return PLAY_LINES[line].text.length * TYPE_MS + 250
}

/** Desktop: line → scan → boxes snap on → Log receives the line → popup on a word → next. */
export function desktopFrames(): Frame[] {
  return PLAY_LINES.flatMap((line, i): Frame[] => {
    const b = base(i)
    return [
      { ...b, ms: typing(i), text: 'typing' },
      { ...b, ms: 650 },
      { ...b, ms: 950, scan: true, emit: 'scan' },
      { ...b, ms: 900, boxes: true, emit: 'line' },
      { ...b, ms: 3000, boxes: true, cursor: line.focus, popup: line.focus >= 0 },
      { ...b, ms: 450, boxes: true },
      { ...b, ms: 350 }
    ]
  })
}

/** Index of Scan in the radial menu (the app's `menuItems()`; see RadialMenu.tsx). */
export const SCAN_ITEM = 0

/**
 * The words Read along steps through on a line. The app steps through every word its dictionary
 * matches; the demo's dictionary is a few entries, so it steps through those (every other word
 * would open an empty pop-up).
 */
export function wordStops(line: number): number[] {
  return PLAY_LINES[line].tokens.flatMap((t, index) => (t.word !== null ? [index] : []))
}

/**
 * Handheld (the app's Gaming Mode, ui/controller.js): both sticks open the menu → ▲ picks Scan →
 * A → the scan runs and Read along starts on the first word, its pop-up open → ▶ steps word to
 * word, the pop-up following → A moves into the pop-up → B back to the text → B back to the game.
 */
export function deckFrames(): Frame[] {
  return PLAY_LINES.flatMap((line, i): Frame[] => {
    const b = base(i)
    const stops = wordStops(i)
    const target = Math.max(0, stops.indexOf(line.focus))
    const path = stops.slice(0, target + 1)
    const text: Reading = { layer: 'text' }
    const at = (cursor: number): Omit<Frame, 'ms'> => ({ ...b, reading: text, cursor, popup: true })
    const menu = (sel: number, chosen = false) => ({ ...b, menu: { sel, chosen } })
    const frames: Frame[] = [
      { ...b, ms: typing(i), text: 'typing' },
      { ...b, ms: 700, hint: 'Kimochi' },
      { ...menu(-1), ms: 380, pressed: ['L3', 'R3'], hint: 'Kimochi' },
      { ...menu(-1), ms: 700 },
      { ...menu(SCAN_ITEM), ms: 260, pressed: ['up'] },
      { ...menu(SCAN_ITEM), ms: 520 },
      { ...menu(SCAN_ITEM, true), ms: 240, pressed: ['A'] },
      { ...b, ms: 950, scan: true, emit: 'scan' },
      { ...b, ms: 420, reading: { layer: 'text', loading: true }, emit: 'line' },
      { ...at(path[0]), ms: 1500 }
    ]
    for (let k = 1; k < path.length; k++) frames.push({ ...at(path[k]), ms: 220, pressed: ['right'] }, { ...at(path[k]), ms: 380 })
    const word = path[path.length - 1]
    frames.push(
      { ...at(word), ms: 900 },
      { ...at(word), ms: 260, pressed: ['A'], reading: { layer: 'popup' } },
      { ...at(word), ms: 1900, reading: { layer: 'popup' } },
      { ...at(word), ms: 260, pressed: ['B'] },
      { ...at(word), ms: 700 },
      { ...b, ms: 260, pressed: ['B'] },
      { ...b, ms: 500 }
    )
    return frames
  })
}

/**
 * Steps through `frames` while `running`. A paused run resumes the current frame from its start.
 * `onEnter` runs once per frame entry (not on resume).
 */
export function usePlayer(
  frames: Frame[],
  running: boolean,
  onEnter?: (frame: Frame) => void,
  /** Restart from the first frame when this changes (e.g. the platform). */
  resetKey?: unknown
): Frame {
  const [index, setIndex] = useState(0)
  const frame = frames[index % frames.length]

  useEffect(() => {
    setIndex(0)
  }, [frames, resetKey])

  useEffect(() => {
    if (!running) return
    const timer = setTimeout(() => setIndex((i) => (i + 1) % frames.length), frame.ms)
    return () => clearTimeout(timer)
  }, [frame, frames.length, running])

  useEffect(() => {
    if (running) onEnter?.(frame)
    // Only on frame entry: resuming the same frame must not re-send it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame])

  return frame
}

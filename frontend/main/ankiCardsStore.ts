/**
 * The cards made in the open session, for the Anki tab and its count: loaded from native
 * (`anki_cards_list`) when the session changes, updated as cards are made or given audio
 * (`anki-cards:changed`) and reloaded after Sync merged another computer's (`sync:release`).
 * Started by the first component that reads it, kept for the window's life.
 */
import { useSyncExternalStore } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getManifest, subscribeSessions } from '@texthooker/lib/sessions'
import {
  normalizeCard,
  sortNewestFirst,
  upsertCard,
  type AnkiCardRecord,
  type AnkiCardsChanged
} from '@texthooker/lib/ankiCards'

export interface AnkiCardsState {
  sessionId: string | null
  /** Newest first. */
  cards: AnkiCardRecord[]
  loaded: boolean
  error: string | null
}

let state: AnkiCardsState = { sessionId: null, cards: [], loaded: false, error: null }
const listeners = new Set<() => void>()
let started = false
let loads = 0

function set(next: AnkiCardsState): void {
  state = next
  for (const listener of listeners) listener()
}

async function load(sessionId: string): Promise<void> {
  const ticket = ++loads
  try {
    const raw = await invoke<unknown[]>('anki_cards_list', { sessionId })
    if (ticket !== loads) return
    const cards = (raw ?? []).map(normalizeCard).filter((c): c is AnkiCardRecord => c !== null)
    set({ sessionId, cards: sortNewestFirst(cards), loaded: true, error: null })
  } catch (error) {
    if (ticket !== loads) return
    set({ sessionId, cards: [], loaded: true, error: String(error) })
  }
}

function start(): void {
  if (started) return
  started = true
  let current: string | null = null
  const follow = (activeId: string | null): void => {
    if (!activeId || activeId === current) return
    current = activeId
    set({ sessionId: activeId, cards: [], loaded: false, error: null })
    void load(activeId)
  }
  try {
    follow(getManifest().activeId)
  } catch {
    // The Log is still loading; its first snapshot names the session.
  }
  subscribeSessions((manifest) => follow(manifest.activeId))
  void listen<AnkiCardsChanged>('anki-cards:changed', ({ payload }) => {
    if (payload.sessionId !== state.sessionId) return
    const card = normalizeCard(payload.card)
    if (card) set({ ...state, cards: upsertCard(state.cards, card) })
  }).catch(() => {})
  void listen<{ changed?: { anki?: string[] } }>('sync:release', ({ payload }) => {
    const sid = state.sessionId
    if (sid && payload.changed?.anki?.includes(sid)) void load(sid)
  }).catch(() => {})
}

/** Delete `card` from the open session's list, and with `fromAnki` its note from Anki too. */
export async function deleteAnkiCard(card: AnkiCardRecord, fromAnki: boolean): Promise<void> {
  const sessionId = state.sessionId
  if (!sessionId) return
  await invoke('anki_cards_delete', { sessionId, noteId: card.noteId, fromAnki })
  if (state.sessionId === sessionId) set({ ...state, cards: state.cards.filter((c) => c.noteId !== card.noteId) })
}

/** Put the card's line's kept clip in its empty sentence-audio field (`sentence_audio_add_to_note`). */
export function addSentenceAudio(card: AnkiCardRecord): Promise<void> {
  return invoke('sentence_audio_add_to_note', { noteId: card.noteId })
}

/** Load the open session's cards again (after AnkiConnect comes back, say). */
export function reloadAnkiCards(): void {
  if (state.sessionId) void load(state.sessionId)
}

export function useAnkiCards(): AnkiCardsState {
  start()
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state
  )
}

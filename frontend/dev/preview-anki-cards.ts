/**
 * DEV-ONLY: the Anki tab's record of the session's cards for the browser preview
 * (`preview-setup.ts`).
 *
 *   (default)          a session's worth of cards, some given sentence (and word) audio by Kimochi
 *   ?ankicards=none    no cards yet this session
 *
 * The tab's "Can't connect to AnkiConnect" state comes from `?anki=notrunning` (or any other
 * failure `previewAnkiStatus` knows).
 */
const CARDS = new URLSearchParams(location.search).get('ankicards')

/** Minutes ago, today, or days ago at a time of day. */
const MIN = 60_000
const at = (minutesAgo: number): number => Date.now() - minutesAgo * MIN

function demoCards(): unknown[] {
  const card = (
    noteId: number,
    term: string,
    reading: string | null,
    minutesAgo: number,
    via: 'kimochi' | 'extension',
    engine: string,
    enhanced: string[] = []
  ) => ({
    noteId,
    term,
    ...(reading ? { reading } : {}),
    deck: 'Mining',
    addedAt: at(minutesAgo),
    via,
    engine,
    enhanced,
    updatedAt: at(minutesAgo)
  })
  return [
    card(1730000000001, '間違い', 'まちがい', 2, 'extension', 'yomitan', ['sentenceAudio', 'wordAudio']),
    card(1730000000002, '地図', 'ちず', 6, 'extension', 'yomitan', ['sentenceAudio']),
    card(1730000000003, '描く', 'えがく', 9, 'kimochi', 'yomitan-api'),
    card(1730000000004, '先生', 'せんせい', 14, 'kimochi', 'yomitan-api', ['sentenceAudio']),
    card(1730000000005, 'お店', 'おみせ', 31, 'extension', 'hachidori'),
    card(1730000000006, '確かめる', 'たしかめる', 26 * 60, 'extension', 'hachidori', ['sentenceAudio']),
    card(1730000000007, '冒険者', 'ぼうけんしゃ', 27 * 60, 'extension', 'yomitan'),
    card(1730000000008, 'ギルド', null, 28 * 60, 'kimochi', 'yomitan-api')
  ]
}

/** Cards the site's demo made (`addDemoCard`), newest first; the session the tab last listed. */
let made: unknown[] = []
let listed: string | null = null

/**
 * The site's demo added `term` to Anki from its pop-up: the card joins the tab's list, as native's
 * `anki-cards:changed` would add it. Returns the event to emit, or null before the tab has listed.
 */
export function addDemoCard(term: string, reading: string | null): { sessionId: string; card: unknown } | null {
  const now = Date.now()
  const card = {
    noteId: 1730000100000 + made.length,
    term,
    ...(reading ? { reading } : {}),
    deck: 'Mining',
    addedAt: now,
    via: 'extension',
    engine: 'hachidori',
    enhanced: ['sentenceAudio', 'screenshot'],
    updatedAt: now
  }
  made = [card, ...made]
  return listed ? { sessionId: listed, card } : null
}

export const ANKI_CARDS_HANDLERS: Record<string, (args: Record<string, unknown> | undefined) => unknown> = {
  anki_cards_list: (args) => {
    listed = typeof args?.sessionId === 'string' ? args.sessionId : listed
    return [...made, ...(CARDS === 'none' ? [] : demoCards())]
  },
  anki_cards_delete: () => null,
  sentence_audio_add_to_note: () => null
}

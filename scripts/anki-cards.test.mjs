/**
 * The Anki tab's model (frontend/texthooker/lib/ankiCards.ts): the session's card records as native
 * sends them, the search, the footer's counts and the "added by Kimochi" mark.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'

const outDir = await mkdtemp(path.join(tmpdir(), 'kimochi-anki-cards-'))
const outfile = path.join(outDir, 'cards.mjs')
await build({
  entryPoints: [fileURLToPath(new URL('../frontend/texthooker/lib/ankiCards.ts', import.meta.url))],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022'
})
const { browseQuery, cardMatches, cardStats, enhancementLabel, normalizeCard, sortNewestFirst, upsertCard } =
  await import(pathToFileURL(outfile).href)
test.after(() => rm(outDir, { recursive: true, force: true }))

const card = (noteId, term, addedAt, extra = {}) => ({
  noteId,
  term,
  addedAt,
  via: 'extension',
  engine: 'yomitan',
  enhanced: [],
  updatedAt: addedAt,
  ...extra
})

test('records from native are made safe to show, unknown enhancements dropped', () => {
  assert.equal(normalizeCard(null), null)
  assert.equal(normalizeCard({ term: '猫' }), null, 'a record names its note')
  assert.deepEqual(normalizeCard({ noteId: 5, enhanced: ['sentenceAudio', 'video', 3], via: 'somewhere' }), {
    noteId: 5,
    term: '',
    reading: undefined,
    deck: undefined,
    addedAt: 0,
    via: 'kimochi',
    engine: '',
    enhanced: ['sentenceAudio'],
    updatedAt: 0
  })
})

test('the list is newest first and a changed card takes its own place', () => {
  const cards = sortNewestFirst([card(1, '一', 10), card(2, '二', 30), card(3, '三', 20)])
  assert.deepEqual(cards.map((c) => c.noteId), [2, 3, 1])
  const enhanced = upsertCard(cards, card(3, '三', 20, { enhanced: ['sentenceAudio'] }))
  assert.deepEqual(enhanced.map((c) => c.noteId), [2, 3, 1])
  assert.deepEqual(enhanced[1].enhanced, ['sentenceAudio'])
  assert.deepEqual(upsertCard(cards, card(4, '四', 40)).map((c) => c.noteId), [4, 2, 3, 1])
})

test('search looks at the word, its reading and the deck', () => {
  const c = card(1, '天気', 1, { reading: 'てんき', deck: 'Japanese::VN' })
  assert.ok(cardMatches(c, ''))
  assert.ok(cardMatches(c, '天'))
  assert.ok(cardMatches(c, ' てん き '))
  assert.ok(cardMatches(c, 'japanese::vn'))
  assert.ok(!cardMatches(c, '猫'))
})

test("the footer counts the session's cards, today's and those given audio", () => {
  const now = new Date(2026, 9, 27, 15, 0).getTime()
  const today = new Date(2026, 9, 27, 0, 5).getTime()
  const yesterday = new Date(2026, 9, 26, 23, 55).getTime()
  const stats = cardStats(
    [card(1, 'a', today), card(2, 'b', yesterday, { enhanced: ['wordAudio'] }), card(3, 'c', now, { enhanced: ['sentenceAudio'] })],
    now
  )
  assert.deepEqual(stats, { total: 3, today: 2, enhanced: 2, screenshots: 0 })
})

test('the mark says what Kimochi added', () => {
  assert.equal(enhancementLabel([]), null)
  assert.equal(enhancementLabel(['sentenceAudio']), 'Sentence audio added by Kimochi')
  assert.equal(enhancementLabel(['wordAudio']), 'Word audio added by Kimochi')
  assert.equal(enhancementLabel(['wordAudio', 'sentenceAudio']), 'Sentence audio and word audio added by Kimochi')
  assert.equal(enhancementLabel(['screenshot', 'wordAudio', 'sentenceAudio']), 'Sentence audio, word audio and screenshot added by Kimochi')
  assert.equal(enhancementLabel(['screenshot']), 'Screenshot added by Kimochi')
  assert.equal(browseQuery({ noteId: 1730000000001 }), 'nid:1730000000001')
})

test('the Anki tab is registered: its command, its event and its sync collection', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const commands = await readFile(path.join(root, 'COMMANDS.md'), 'utf8')
  assert.match(commands, /`anki_cards_list`/)
  assert.match(commands, /`anki-cards:changed`/)
  const native = await readFile(path.join(root, 'src-tauri/src/anki_cards.rs'), 'utf8')
  assert.match(native, /pub const EVENT: &str = "anki-cards:changed";/)
  const store = await readFile(path.join(root, 'frontend/main/ankiCardsStore.ts'), 'utf8')
  assert.match(store, /'anki-cards:changed'/)
  const sync = await readFile(path.join(root, 'src-tauri/src/sync_core.rs'), 'utf8')
  assert.match(sync, /HOST_COLLECTIONS: &\[&str\] = &\[[^\]]*"anki"/)
})

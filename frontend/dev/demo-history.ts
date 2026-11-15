/**
 * DEV-ONLY: a reading history for the browser preview's Stats tab (`reading_history_lines`):
 * about seven months of evenings across the demo sessions, with gaps, a long run in the summer and
 * a streak running up to today, plus a session since deleted. Seeded, so every load looks the same.
 */
import { countChars } from '../texthooker/core/charCount'
import { DEMO_CONTENT } from './demo-content'
import { SESSION_IDS } from './demo-data'

interface PreviewHistoryLine {
  uid: string
  ts: number
  tz: number
  text: string
  chars: number
  via: string
  session: string
  sessionName: string
  backfilled?: boolean
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const DELETED = { id: '0a9b8c7d-6e5f-4a3b-9c2d-1e0f9a8b7c05', name: 'ひぐらしのなく頃に' }

const TEXTS: Record<string, string[]> = {
  [SESSION_IDS.steinsGate]: DEMO_CONTENT.lines.map((line) => line.text),
  [SESSION_IDS.ace]: [
    '「異議あり！」',
    '「証人の発言には、明らかなムジュンがあります！」',
    '法廷内がざわめいた。',
    '「待った！　その証言、もう少し詳しく聞かせてもらえますか」',
    '裁判長は木槌を打ち鳴らし、静粛を求めた。'
  ],
  [SESSION_IDS.persona]: [
    '「ようこそ、ベルベットルームへ」',
    '怪盗団の予告状が、街中に貼られていた。',
    '放課後、屋上に集まった仲間たちは次の標的について話し合った。',
    '「お前の心、頂戴する」'
  ],
  [SESSION_IDS.yotsuba]: ['「とーちゃん！　セミとった！」', 'よつばは走っていった。', '「なんで？」'],
  [DELETED.id]: [
    'ひぐらしの声が、夕暮れの村に響いていた。',
    '「嘘だッ！」',
    '雛見沢の夏は、いつもと変わらないはずだった。'
  ]
}

const NAMES: Record<string, string> = {
  [SESSION_IDS.steinsGate]: DEMO_CONTENT.title,
  [SESSION_IDS.ace]: '逆転裁判',
  [SESSION_IDS.persona]: 'Persona 5 Royal',
  [SESSION_IDS.yotsuba]: 'よつばと！ 第1巻',
  [DELETED.id]: DELETED.name
}

/** A small seeded generator (mulberry32). */
function random(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let cache: PreviewHistoryLine[] | null = null

function build(): PreviewHistoryLine[] {
  const rand = random(178)
  const tz = -new Date().getTimezoneOffset()
  const out: PreviewHistoryLine[] = []
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const DAYS = 220
  // Which game each stretch of days was spent on, oldest first.
  const plan = (back: number): string =>
    back > 170
      ? DELETED.id
      : back > 120
        ? SESSION_IDS.persona
        : back > 70
          ? SESSION_IDS.ace
          : back > 50
            ? SESSION_IDS.yotsuba
            : SESSION_IDS.steinsGate
  let n = 0
  for (let back = DAYS; back >= 0; back--) {
    // The last 12 days are a streak; the summer (about 100–130 days back) a long one; else ~55%.
    const streak = back < 12 || (back > 98 && back < 131)
    if (!streak && rand() > 0.55) continue
    const session = plan(back)
    const texts = TEXTS[session]
    const sittings = rand() > 0.7 ? 2 : 1
    for (let s = 0; s < sittings; s++) {
      // Evenings mostly, sometimes a lunchtime or a late night.
      const hour = s === 1 ? 12 + Math.floor(rand() * 2) : rand() > 0.85 ? 23 : 19 + Math.floor(rand() * 3)
      let ts = midnight.getTime() - back * DAY + hour * 60 * MINUTE + Math.floor(rand() * 40) * MINUTE
      if (back === 0 && ts > Date.now()) ts = Date.now() - 50 * MINUTE
      const count = 30 + Math.floor(rand() * (back < 40 ? 220 : 140))
      for (let i = 0; i < count; i++) {
        const text = texts[Math.floor(rand() * texts.length)]
        const chars = countChars(text)
        out.push({
          uid: `preview-${n++}`,
          ts,
          tz,
          text,
          chars,
          via: 'ocr',
          session,
          sessionName: NAMES[session],
          ...(back > 150 ? { backfilled: true } : {})
        })
        // About 4–9 characters a second, with a pause now and then.
        ts += Math.round((chars / (4 + rand() * 5)) * 1000) + (rand() > 0.97 ? 4 * MINUTE : 0)
        if (back === 0 && ts > Date.now()) break
      }
    }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

/** `reading_history_lines`: the preview's history, of `sessions` when given, with only `fields`. */
export function previewHistoryLines(args: { sessions?: string[]; fields?: string[] } | undefined): unknown[] {
  cache ??= build()
  const sessions = args?.sessions ? new Set(args.sessions) : null
  const fields = args?.fields
  return cache
    .filter((line) => !sessions || sessions.has(line.session))
    .map((line) => (fields ? Object.fromEntries(Object.entries(line).filter(([key]) => fields.includes(key))) : line))
}

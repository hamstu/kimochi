/**
 * DEV-ONLY: what the overlay stage's pretend game says, and what its pretend dictionary knows.
 * The studio edits these as JSON (`studioJson('script')`, `studioJson('history')`); opened on its
 * own, the stage uses the defaults here.
 *
 * Readings are written inline the way a game prints furigana: `今日《きょう》` is 今日 with きょう
 * above it (the kanji run right before 《…》 takes it).
 */

export interface StageWord {
  reading: string
  meaning: string
}

export interface StageScript {
  /** The visual novel's speaker, on the name plate over the dialogue box. */
  speaker: string
  /** The dialogue box's lines, in reading order. */
  lines: string[]
  /** The manga page's speech bubbles, each a list of columns read right to left. */
  bubbles: string[][]
  /** What the pop-up shows for a lookup starting with each word; the longest match wins. */
  words: Record<string, StageWord>
}

export interface StageHistoryEntry {
  id: string
  text: string
  timestamp?: number
  source?: { appName?: string; name?: string }
}

export const DEFAULT_SCRIPT: StageScript = {
  speaker: 'マリエ',
  lines: ['今日《きょう》はいい天気《てんき》ですね。', '一緒《いっしょ》に海《うみ》まで散歩《さんぽ》しませんか？'],
  bubbles: [
    ['待《ま》って！', 'まだ話《はなし》は', '終《お》わってない'],
    ['この剣《けん》で', '世界《せかい》を守《まも》る']
  ],
  words: {
    今日: { reading: 'きょう', meaning: 'today; this day' },
    天気: { reading: 'てんき', meaning: 'weather; the elements' },
    いい: { reading: 'いい', meaning: 'good; excellent; fine; nice' },
    一緒: { reading: 'いっしょ', meaning: 'together; at the same time' },
    海: { reading: 'うみ', meaning: 'sea; ocean; waters' },
    散歩: { reading: 'さんぽ', meaning: 'walk; stroll' },
    待って: { reading: 'まって', meaning: 'wait!; hold on' },
    話: { reading: 'はなし', meaning: 'talk; conversation; story' },
    終わって: { reading: 'おわって', meaning: 'to end; to finish (te-form)' },
    剣: { reading: 'けん', meaning: 'sword; blade' },
    世界: { reading: 'せかい', meaning: 'the world; society; the universe' },
    守る: { reading: 'まもる', meaning: 'to protect; to guard; to defend' }
  }
}

const minutesAgo = (minutes: number): number => Date.now() - minutes * 60_000

export const DEFAULT_HISTORY: StageHistoryEntry[] = [
  { id: 'h1', text: '一緒に海まで散歩しませんか？', timestamp: minutesAgo(1), source: { appName: 'Summer Pockets' } },
  { id: 'h2', text: '今日はいい天気ですね。', timestamp: minutesAgo(2), source: { appName: 'Summer Pockets' } },
  { id: 'h3', text: 'この剣で世界を守る', timestamp: minutesAgo(14), source: { appName: 'Chrono Trigger' } },
  {
    id: 'h4',
    text: 'ちなみに、タッチスクリーンを短くタッチすると、話したり調べたりもできるのよ。',
    timestamp: minutesAgo(31),
    source: { appName: 'Chrono Trigger' }
  }
]

/** One run of a line: plain text, or a base with its reading above. */
export type Run = { text: string; ruby?: string }

/** `今日《きょう》は` → [{text: 今日, ruby: きょう}, {text: は}]. */
export function parseRuby(line: string): Run[] {
  const runs: Run[] = []
  const pattern = /([㐀-鿿々〆ヵヶ]+)《([^》]+)》/g
  let at = 0
  for (const match of line.matchAll(pattern)) {
    if (match.index > at) runs.push({ text: line.slice(at, match.index) })
    runs.push({ text: match[1], ruby: match[2] })
    at = match.index + match[0].length
  }
  if (at < line.length) runs.push({ text: line.slice(at) })
  return runs
}

export const plainText = (line: string): string => parseRuby(line).map((run) => run.text).join('')

/** The entry for a lookup starting at `text`: its longest known word, else its first character. */
export function lookupWord(script: StageScript, text: string): { term: string; word: StageWord | null } {
  const term = Object.keys(script.words)
    .filter((key) => text.startsWith(key))
    .sort((a, b) => b.length - a.length)[0]
  if (term) return { term, word: script.words[term] }
  return { term: [...text][0] ?? text, word: null }
}

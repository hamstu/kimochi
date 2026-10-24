/**
 * DEV-ONLY: a pretend Yomitan API for the overlay stage's full-screen dictionary
 * (`?dictionary=full`): `/tokenize` as Yomitan's scanning parser answers it, and `/ankiFields`
 * entries shaped as Kimochi's `yomitan_ankifields` returns them (glossary HTML, readings, tags,
 * inflections, frequencies), several for some words so the entry tabs show.
 */
import type { StageScript } from './script'

interface Fields {
  expression: string
  reading: string
  glossary: string
  dictionary: string
  'part-of-speech'?: string
  tags?: string
  conjugation?: string
  frequencies?: string
  audio?: string
}

const gloss = (...senses: string[]): string =>
  `<div style="text-align: left;"><ol>${senses.map((sense) => `<li>${sense}</li>`).join('')}</ol></div>`
const freq = (rank: number): string => `<ul><li>JPDB: ${rank}</li><li>BCCWJ: ${rank * 3 + 41}</li></ul>`

/** Richer entries than the stage script's one-line meanings, for the words a reader steps on first. */
const ENTRIES: Record<string, Fields[]> = {
  今日: [
    {
      expression: '今日',
      reading: 'きょう',
      glossary: gloss('<i>(n, adv)</i> today; this day', '<i>(n, adv)</i> these days; recently; nowadays'),
      dictionary: 'JMdict (English)',
      'part-of-speech': 'n, adv',
      tags: 'P, ichi1',
      frequencies: freq(118),
      audio: '[sound:kyou.mp3]'
    },
    {
      expression: '今日',
      reading: 'こんにち',
      glossary: gloss('<i>(n, adv)</i> today; this day', '<i>(n, adv)</i> these days; recently; nowadays'),
      dictionary: 'JMdict (English)',
      'part-of-speech': 'n, adv',
      tags: 'P, news1',
      frequencies: freq(5120)
    }
  ],
  は: [
    {
      expression: 'は',
      reading: 'は',
      glossary: gloss(
        '<i>(prt)</i> indicates sentence topic',
        '<i>(prt)</i> indicates contrast with another option (stated or unstated)',
        '<i>(prt)</i> adds emphasis'
      ),
      dictionary: 'JMdict (English)',
      'part-of-speech': 'prt',
      tags: 'P, spec1',
      frequencies: freq(2)
    }
  ],
  いい: [
    {
      expression: 'いい',
      reading: 'いい',
      glossary: gloss(
        '<i>(adj-ix)</i> good; excellent; fine; nice; pleasant; agreeable',
        '<i>(adj-ix)</i> sufficient (can be used to turn down an offer); ready; prepared',
        '<i>(adj-ix)</i> profitable (e.g. deal, business offer, etc.); beneficial',
        '<i>(adj-ix)</i> OK; all right; fine; no problem'
      ),
      dictionary: 'JMdict (English)',
      'part-of-speech': 'adj-ix',
      tags: 'P, ichi1, spec1',
      frequencies: freq(34),
      audio: '[sound:ii.mp3]'
    },
    {
      expression: '良い',
      reading: 'よい',
      glossary: gloss('<i>(adj-i)</i> good; excellent; fine; nice; pleasant; agreeable', '<i>(adj-i)</i> sufficient; enough; ready'),
      dictionary: 'JMdict (English)',
      'part-of-speech': 'adj-i',
      tags: 'P, ichi1',
      frequencies: freq(410)
    }
  ],
  天気: [
    {
      expression: '天気',
      reading: 'てんき',
      glossary: gloss(
        '<i>(n)</i> weather; the elements',
        '<i>(n)</i> fair weather; fine weather',
        `<i>(n)</i> mood; temper<div data-sc-content="example-sentence-a">お天気屋だから気にしないで。</div><div data-sc-content="example-sentence-b">Don't mind him, he's moody.</div>`
      ),
      dictionary: 'JMdict (English)',
      'part-of-speech': 'n',
      tags: 'P, ichi1, news1',
      frequencies: freq(1430),
      audio: '[sound:tenki.mp3]'
    },
    {
      expression: '天',
      reading: 'てん',
      glossary: gloss('<i>(n)</i> sky; heavens', '<i>(n)</i> God; Heaven; providence'),
      dictionary: 'JMdict (English)',
      'part-of-speech': 'n',
      tags: 'P, ichi1',
      frequencies: freq(3901)
    }
  ],
  です: [
    {
      expression: 'です',
      reading: 'です',
      glossary: gloss('<i>(cop)</i> be; is'),
      dictionary: 'JMdict (English)',
      'part-of-speech': 'cop, aux-v',
      tags: 'P, spec1',
      frequencies: freq(9)
    }
  ],
  ね: [
    {
      expression: 'ね',
      reading: 'ね',
      glossary: gloss(
        "<i>(prt)</i> right?; isn't it?; doesn't it?; don't you?; don't you think?",
        '<i>(prt)</i> hey; say; listen; look; come on'
      ),
      dictionary: 'JMdict (English)',
      'part-of-speech': 'prt',
      tags: 'P, spec1',
      frequencies: freq(21)
    }
  ],
  しません: [
    {
      expression: 'する',
      reading: 'する',
      glossary: gloss('<i>(vs-i)</i> to do; to carry out; to perform', '<i>(vs-i)</i> to cause to become; to make (into)', '<i>(vs-i)</i> to serve as; to act as'),
      dictionary: 'JMdict (English)',
      'part-of-speech': 'vs-i',
      tags: 'P, spec1',
      conjugation: 'polite « negative',
      frequencies: freq(4),
      audio: '[sound:suru.mp3]'
    }
  ],
  まで: [
    {
      expression: 'まで',
      reading: 'まで',
      glossary: gloss('<i>(prt)</i> until (a time); till; to; up to', '<i>(prt)</i> to (a place); as far as'),
      dictionary: 'JMdict (English)',
      'part-of-speech': 'prt',
      tags: 'P, ichi1',
      frequencies: freq(64)
    }
  ],
  に: [
    {
      expression: 'に',
      reading: 'に',
      glossary: gloss('<i>(prt)</i> at (place, time); in; on; during', '<i>(prt)</i> to (direction, state); toward; into'),
      dictionary: 'JMdict (English)',
      'part-of-speech': 'prt',
      tags: 'P',
      frequencies: freq(3)
    }
  ],
  か: [
    {
      expression: 'か',
      reading: 'か',
      glossary: gloss('<i>(prt)</i> indicates a question', '<i>(prt)</i> or; whether or'),
      dictionary: 'JMdict (English)',
      'part-of-speech': 'prt',
      tags: 'P',
      frequencies: freq(11)
    }
  ]
}

/** Every word the pretend dictionary knows: the rich ones, then the stage script's. */
function known(script: StageScript): Record<string, Fields[]> {
  const words: Record<string, Fields[]> = {}
  for (const [term, word] of Object.entries(script.words)) {
    words[term] = [
      {
        expression: term,
        reading: word.reading,
        glossary: gloss(word.meaning),
        dictionary: 'JMdict (English)'
      }
    ]
  }
  return { ...words, ...ENTRIES }
}

/** `/tokenize`: the longest known word at each position; anything else one unmatched run. */
export function apiTokenize(script: StageScript, text: string): unknown {
  const words = Object.keys(known(script)).sort((a, b) => b.length - a.length)
  const content: { text: string; headwords?: unknown[] }[][] = []
  let gap = ''
  for (let at = 0; at < text.length; ) {
    const word = words.find((candidate) => text.startsWith(candidate, at))
    if (!word) {
      gap += text[at++]
      continue
    }
    if (gap) content.push([{ text: gap }])
    gap = ''
    content.push([{ text: word, headwords: [[{ term: word }]] }])
    at += word.length
  }
  if (gap) content.push([{ text: gap }])
  return [{ source: 'scanning-parser', content }]
}

/** `/ankiFields` for a term: its entries, longest match first. */
export function apiEntries(script: StageScript, term: string): { entries: Fields[]; audioMedia: unknown[]; dictionaryMedia: unknown[] } {
  const words = known(script)
  const match = Object.keys(words)
    .filter((word) => term.startsWith(word))
    .sort((a, b) => b.length - a.length)[0]
  return { entries: match ? words[match] : [], audioMedia: [], dictionaryMedia: [] }
}

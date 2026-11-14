/**
 * Sample text for the previews that stand for "your text" (Settings → Overlay → Overlay appearance, the capture
 * border step's game, the Text Hooker card's example), by the language being read. A language
 * with no sample here is previewed with glyph blocks instead (frontend/components/GlyphBlocks.tsx),
 * so nothing claims to be text in a language it is not.
 *
 * NOT YET CHECKED BY NATIVE SPEAKERS. Every sentence but Japanese was machine-written
 * (docs/languages-audit/language-data.md section 4) and needs a native speaker's check before
 * release. Keep them short and plain: one everyday sentence, the same idea in each (an old village
 * beyond a mountain, forest or river), so the previews compare.
 */
import { languageOf } from './languages.js'

export interface LanguageSample {
  /** One sentence, as a game would show it. */
  sentence: string
  /** Words of `sentence` that make a good selected word (as they appear in it). */
  highlights: readonly string[]
  /**
   * A few words of `sentence` (in order, without the spaces between them) for a one-line preview,
   * and the one shown hovered (`lit`, an index into them).
   */
  preview: readonly string[]
  lit: number
}

const SAMPLES: Readonly<Record<string, LanguageSample>> = {
  // Japanese keeps the line its previews always showed (今日はいい天気ですね, 天気 hovered).
  ja: {
    sentence: 'この先の森には、古い神社があると聞きました。',
    highlights: ['森', '神社', '聞きました'],
    preview: ['今日は', 'いい', '天気', 'ですね'],
    lit: 2
  },
  ko: {
    sentence: '저 산 너머에 오래된 마을이 있다고 들었어요.',
    highlights: ['산', '마을', '들었어요'],
    preview: ['오래된', '마을이', '있다고'],
    lit: 1
  },
  'zh-Hans': {
    sentence: '听说山的那边有一座古老的村庄，我们明天出发吧。',
    highlights: ['听说', '村庄', '出发'],
    preview: ['一座', '古老', '的', '村庄'],
    lit: 3
  },
  'zh-Hant': {
    sentence: '聽說山的那邊有一座古老的村莊，我們明天出發吧。',
    highlights: ['聽說', '村莊', '出發'],
    preview: ['一座', '古老', '的', '村莊'],
    lit: 3
  },
  en: {
    sentence: 'They say there is an old village on the other side of the river.',
    highlights: ['village', 'river', 'side'],
    preview: ['an', 'old', 'village'],
    lit: 2
  },
  es: {
    sentence: 'Dicen que al otro lado del río hay un pueblo muy antiguo.',
    highlights: ['río', 'pueblo', 'antiguo'],
    preview: ['un', 'pueblo', 'muy', 'antiguo'],
    lit: 1
  },
  fr: {
    sentence: "On raconte qu'un vieux village se cache derrière cette montagne.",
    highlights: ['village', 'cache', 'montagne'],
    preview: ['un', 'vieux', 'village'],
    lit: 2
  },
  de: {
    sentence: 'Hinter dem Wald soll es ein altes Dorf am Fluss geben.',
    highlights: ['Wald', 'Dorf', 'Fluss'],
    preview: ['ein', 'altes', 'Dorf'],
    lit: 2
  },
  it: {
    sentence: 'Dicono che oltre il fiume ci sia un piccolo villaggio antico.',
    highlights: ['fiume', 'villaggio', 'antico'],
    preview: ['un', 'villaggio', 'antico'],
    lit: 1
  },
  pt: {
    sentence: 'Dizem que do outro lado do rio existe uma aldeia muito antiga.',
    highlights: ['rio', 'aldeia', 'antiga'],
    preview: ['uma', 'aldeia', 'muito', 'antiga'],
    lit: 1
  },
  ru: {
    sentence: 'Говорят, что за этим лесом есть старая деревня у реки.',
    highlights: ['лесом', 'деревня', 'реки'],
    preview: ['старая', 'деревня', 'у', 'реки'],
    lit: 1
  },
  hi: {
    sentence: 'कहते हैं कि उस पहाड़ के पीछे एक पुराना गाँव है।',
    highlights: ['पहाड़', 'पुराना', 'गाँव'],
    preview: ['एक', 'पुराना', 'गाँव', 'है।'],
    lit: 2
  },
  // Thai has no spaces between words; the preview's words are its word boundaries.
  th: {
    sentence: 'ว่ากันว่าหลังภูเขาลูกนั้นมีหมู่บ้านเก่าแก่อยู่',
    highlights: ['ภูเขา', 'หมู่บ้าน', 'เก่าแก่'],
    preview: ['มี', 'หมู่บ้าน', 'เก่าแก่'],
    lit: 1
  },
  // ngôi làng is two syllables that make one word (classifier and noun): a selection of two.
  vi: {
    sentence: 'Người ta nói rằng phía sau ngọn núi kia có một ngôi làng cổ.',
    highlights: ['núi', 'ngôi làng', 'cổ'],
    preview: ['có', 'một', 'ngôi làng', 'cổ'],
    lit: 2
  },
  id: {
    sentence: 'Katanya di balik gunung itu ada sebuah desa yang sangat tua.',
    highlights: ['gunung', 'desa', 'tua'],
    preview: ['ada', 'sebuah', 'desa'],
    lit: 2
  },
  tr: {
    sentence: 'Bu dağın ardında çok eski bir köy olduğunu söylüyorlar.',
    highlights: ['dağın', 'köy', 'söylüyorlar'],
    preview: ['çok', 'eski', 'bir', 'köy'],
    lit: 3
  },
  pl: {
    sentence: 'Mówią, że za tym lasem jest stara wioska nad rzeką.',
    highlights: ['lasem', 'wioska', 'rzeką'],
    preview: ['stara', 'wioska', 'nad', 'rzeką'],
    lit: 1
  },
  nl: {
    sentence: 'Ze zeggen dat er achter het bos een oud dorp ligt.',
    highlights: ['bos', 'dorp', 'ligt'],
    preview: ['een', 'oud', 'dorp', 'ligt'],
    lit: 2
  },
  sv: {
    sentence: 'De säger att det finns en gammal by bakom den där skogen.',
    highlights: ['gammal', 'by', 'skogen'],
    preview: ['en', 'gammal', 'by'],
    lit: 1
  }
}

/** The sample for the language `code` (absent or unknown: Japanese), or null when it has none. */
export function sampleFor(code?: unknown): LanguageSample | null {
  return SAMPLES[languageOf(code).code] ?? null
}

/** The languages that have a sample. */
export const SAMPLE_LANGUAGES: readonly string[] = Object.keys(SAMPLES)

/**
 * DEV-ONLY demo content for the browser preview harness.
 *
 * Seeds the in-memory filesystem with the exact files the texthooker core reads
 * (`sessions.json`, `sessions/<id>/lines.json`, `sessions/<id>/notebook.json`, `stats.json`,
 * `presets.json`) and provides placeholder art (SVG data URIs, canvas-rendered PNGs) so screens
 * are representative without any network access.
 */
import { previewFs } from './mocks/plugin-fs'
import { SETTINGS_DEFAULTS as READER_DEFAULTS } from '../texthooker/lib/types'
import type {
  Line,
  NotebookEntry,
  NotebookFile,
  SessionsManifest
} from '../texthooker/lib/types'

const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = Date.now()

export const SESSION_IDS = {
  steinsGate: '5f2c7c7e-1a0b-4c65-9d7e-7d1f6b0c5a01',
  ace: '8b41e0a2-37c4-4c3e-a8d4-2e9a41b77c02',
  persona: 'c3d9a8f1-5b62-4f0e-9c1a-0f4b8e2d6a03',
  yotsuba: 'e7a1b2c3-9d84-4e5f-8a6b-1c2d3e4f5a04'
} as const

export const manifest: SessionsManifest = {
  version: 1,
  activeId: SESSION_IDS.steinsGate,
  sessions: [
    {
      id: SESSION_IDS.steinsGate,
      name: 'Steins;Gate',
      description: 'Chapter 3 — the phone microwave (name subject to change).',
      createdAt: NOW - 12 * DAY,
      updatedAt: NOW - 5 * 60_000
    },
    {
      id: SESSION_IDS.ace,
      name: '逆転裁判',
      description: 'Turnabout Sisters, trial day 2.',
      createdAt: NOW - 30 * DAY,
      updatedAt: NOW - 3 * DAY
    },
    {
      id: SESSION_IDS.persona,
      name: 'Persona 5 Royal',
      description: '',
      createdAt: NOW - 45 * DAY,
      updatedAt: NOW - 9 * DAY
    },
    {
      id: SESSION_IDS.yotsuba,
      name: 'よつばと！ 第1巻',
      description: 'Manga via screen OCR.',
      createdAt: NOW - 60 * DAY,
      updatedAt: NOW - 21 * DAY
    }
  ]
}

const SG_TEXT: [string, { translation?: string; showTranslation?: boolean; explanation?: string }?][] = [
  ['秋葉原の夏は、今年も容赦なく暑かった。'],
  ['「フゥーハハハ！　我が名は鳳凰院凶真！　狂気のマッドサイエンティストだ！」'],
  ['「オカリン、また独り言言ってる〜」'],
  [
    'まゆりはいつものように、のんびりとした笑顔でバナナを頬張っていた。',
    {
      translation: 'Mayuri was munching on a banana with her usual easygoing smile.',
      showTranslation: false
    }
  ],
  ['ラジ館の屋上に、人工衛星のようなものが突き刺さっている。'],
  ['「……あなた、さっき私に何か言おうとしてたわよね？」'],
  [
    '「牧瀬紅莉栖。十八歳にして論文がサイエンス誌に載った天才少女だ」',
    {
      translation:
        '"Makise Kurisu. A genius girl whose paper was published in Science at just eighteen."',
      showTranslation: true
    }
  ],
  ['「助手よ、コーヒーを淹れてくれたまえ」'],
  ['「誰が助手よ！」'],
  ['電話レンジ（仮）の扉が開くと、中のバナナはゲル状に変化していた。'],
  [
    '「これは……ただの電子レンジじゃない。時間を超えてメールを送れる装置なのかもしれない」',
    {
      explanation:
        '**Translation:** "This... isn\'t just a microwave. It might be a device that can send mail across time."\n\n- **ただの〜じゃない** — "not merely a ~".\n- **かもしれない** — speculative "might be".'
    }
  ],
  ['ダルはモニターから目を離さずに、キーボードを叩き続けている。'],
  ['「オカリン、それってSERNにハッキングするってこと？　マジで？」'],
  ['世界線が、ほんのわずかに揺らいだ気がした。'],
  ['「エル・プサイ・コングルゥ」']
]

function sgLines(): Line[] {
  const start = NOW - 42 * 60_000
  return SG_TEXT.map(([text, extra], index) => ({
    id: index + 1,
    text,
    tokens: null,
    source: 'ocr' as const,
    ts: start + index * 160_000,
    ...(extra ?? {})
  }))
}

const otherLines: Record<string, string[]> = {
  [SESSION_IDS.ace]: [
    '「異議あり！」',
    '「証人の発言には、明らかなムジュンがあります！」',
    '法廷内がざわめいた。'
  ],
  [SESSION_IDS.persona]: ['「ようこそ、ベルベットルームへ」', '怪盗団の予告状が、街中に貼られていた。'],
  [SESSION_IDS.yotsuba]: ['「とーちゃん！　セミとった！」']
}

type ImageSpec = { hue: number; glyph: string }

/** A simple portrait/landscape placeholder rendered to PNG bytes, since the app reads `.png` files. */
async function placeholderPng({ hue, glyph }: ImageSpec, width = 240, height = 320): Promise<Uint8Array> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const gradient = ctx.createLinearGradient(0, 0, width, height)
  gradient.addColorStop(0, `hsl(${hue} 55% 62%)`)
  gradient.addColorStop(1, `hsl(${(hue + 40) % 360} 45% 32%)`)
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, width, height)
  ctx.fillStyle = 'rgba(255,255,255,0.18)'
  ctx.beginPath()
  ctx.arc(width / 2, height * 0.4, width * 0.26, 0, Math.PI * 2)
  ctx.fill()
  ctx.beginPath()
  ctx.ellipse(width / 2, height * 0.95, width * 0.42, height * 0.3, 0, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = `600 ${Math.round(width * 0.28)}px "Hiragino Sans", "Noto Sans JP", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(glyph, width / 2, height * 0.4)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  )
  return new Uint8Array(await blob.arrayBuffer())
}

function sgNotebook(images: Record<string, string>): NotebookFile {
  const t = NOW - 10 * DAY
  const img = (key: string) =>
    images[key]
      ? [{ id: `img-${key}`, path: images[key], width: 240, height: 320, addedAt: t }]
      : []
  const note = (id: string, text: string) => ({ id, text, createdAt: t, updatedAt: t })
  const entries: NotebookEntry[] = [
    {
      id: 'nb-okabe',
      kind: 'person',
      family: '岡部',
      given: '倫太郎',
      familyReading: 'おかべ',
      givenReading: 'りんたろう',
      matchGivenAlone: true,
      aliases: ['オカリン', '鳳凰院凶真'],
      description:
        'Self-proclaimed mad scientist and founder of the Future Gadget Laboratory. Calls himself 鳳凰院凶真.',
      notes: [note('n1', 'Uses 我 / 我が for dramatic effect — not normal speech.')],
      images: img('okabe'),
      matchEnabled: true,
      createdAt: t,
      updatedAt: t,
      vndbId: 'c3401'
    },
    {
      id: 'nb-mayuri',
      kind: 'person',
      family: '椎名',
      given: 'まゆり',
      familyReading: 'しいな',
      givenReading: 'まゆり',
      matchGivenAlone: true,
      aliases: ['まゆしぃ'],
      description: "Okabe's childhood friend. Refers to herself as まゆしぃ.",
      notes: [],
      images: img('mayuri'),
      matchEnabled: true,
      createdAt: t,
      updatedAt: t
    },
    {
      id: 'nb-kurisu',
      kind: 'person',
      family: '牧瀬',
      given: '紅莉栖',
      familyReading: 'まきせ',
      givenReading: 'くりす',
      matchGivenAlone: true,
      aliases: ['助手', 'クリスティーナ'],
      description: 'Neuroscience researcher, 18. Okabe insists on calling her 助手 ("assistant").',
      notes: [note('n2', '紅莉栖 is an ateji reading — worth remembering.')],
      images: [],
      matchEnabled: true,
      createdAt: t,
      updatedAt: t
    },
    {
      id: 'nb-akiba',
      kind: 'place',
      name: '秋葉原',
      reading: 'あきはばら',
      aliases: ['アキバ'],
      description: "Tokyo's electronics and otaku district, where the lab is located.",
      notes: [],
      images: img('akiba'),
      matchEnabled: true,
      createdAt: t,
      updatedAt: t
    },
    {
      id: 'nb-lab',
      kind: 'place',
      name: '未来ガジェット研究所',
      reading: 'みらいガジェットけんきゅうじょ',
      aliases: ['ラボ'],
      description: 'The "Future Gadget Laboratory", above a CRT shop.',
      notes: [],
      images: [],
      matchEnabled: true,
      createdAt: t,
      updatedAt: t
    },
    {
      id: 'nb-microwave',
      kind: 'thing',
      name: '電話レンジ（仮）',
      reading: 'でんわレンジかっこかり',
      aliases: ['電話レンジ'],
      description: 'Future Gadget #8: a microwave controlled by phone. (仮) = "tentative name".',
      notes: [
        note('n3', '（仮） is read かっこかり — "parenthesis, provisional".'),
        note('n4', 'Turns bananas into gel.')
      ],
      images: [],
      matchEnabled: true,
      createdAt: t,
      updatedAt: t
    }
  ]
  return { version: 2, cacheVersion: 1, entries }
}

/** Writes every file the texthooker core loads. Idempotent per page load. */
export async function seedFilesystem(): Promise<void> {
  previewFs.put('sessions.json', JSON.stringify(manifest))
  const images: Record<string, string> = {}
  const specs: Record<string, ImageSpec> = {
    okabe: { hue: 262, glyph: '岡' },
    mayuri: { hue: 330, glyph: 'ま' },
    akiba: { hue: 200, glyph: '秋' }
  }
  for (const [key, spec] of Object.entries(specs)) {
    const path = `sessions/${SESSION_IDS.steinsGate}/images/${key}.png`
    try {
      previewFs.put(path, await placeholderPng(spec))
      images[key] = path
    } catch (error) {
      console.warn('[preview] placeholder image failed', error)
    }
  }
  previewFs.put(
    `sessions/${SESSION_IDS.steinsGate}/lines.json`,
    JSON.stringify({ version: 1, lines: sgLines() })
  )
  previewFs.put(`sessions/${SESSION_IDS.steinsGate}/notebook.json`, JSON.stringify(sgNotebook(images)))
  for (const [sid, texts] of Object.entries(otherLines)) {
    const lines: Line[] = texts.map((text, i) => ({
      id: i + 1,
      text,
      tokens: null,
      source: 'ocr',
      ts: NOW - 5 * DAY + i * 60_000
    }))
    previewFs.put(`sessions/${sid}/lines.json`, JSON.stringify({ version: 1, lines }))
    previewFs.put(
      `sessions/${sid}/notebook.json`,
      JSON.stringify({ version: 2, cacheVersion: 0, entries: [] })
    )
  }
  previewFs.put(
    'stats.json',
    JSON.stringify({
      version: 1,
      totalMs: 2 * HOUR + 13 * 60_000,
      totalChars: 18_432,
      totalLines: 612,
      lastUpdateTs: NOW - 60_000
    })
  )
  previewFs.put(
    'presets.json',
    JSON.stringify({
      version: 1,
      active: 'Default',
      presets: {
        Default: { settings: { ...READER_DEFAULTS }, replacements: [] },
        'VN — large text': {
          settings: { ...READER_DEFAULTS, fontSizePx: 20, showFurigana: true },
          replacements: [
            { id: 'r1', pattern: '\\s+', flags: 'g', replacement: '', enabled: true }
          ]
        }
      }
    })
  )
}

// ------------------------------------------------------------------ source art (SVG data URIs)

const svgUri = (svg: string): string => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`

/** A fake screenshot: title bar, text box, coloured scene. */
export function thumbnailSvg(name: string, hue: number, kind: 'display' | 'window', w = 640, h = 400): string {
  const bar =
    kind === 'window'
      ? `<rect width="${w}" height="28" fill="hsl(${hue} 10% 22%)"/>
         <circle cx="16" cy="14" r="5" fill="#ff5f57"/><circle cx="32" cy="14" r="5" fill="#febc2e"/><circle cx="48" cy="14" r="5" fill="#28c840"/>
         <text x="${w / 2}" y="18" font-family="-apple-system, sans-serif" font-size="12" fill="#ddd" text-anchor="middle">${name}</text>`
      : `<rect width="${w}" height="20" fill="rgba(255,255,255,0.35)"/>`
  const body =
    kind === 'window'
      ? `<rect x="40" y="${h - 130}" width="${w - 80}" height="96" rx="10" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.4)"/>
         <text x="64" y="${h - 90}" font-family="Hiragino Sans, sans-serif" font-size="20" fill="#fff">「世界線が、ほんのわずかに揺らいだ」</text>`
      : `<rect x="60" y="70" width="240" height="160" rx="8" fill="rgba(255,255,255,0.8)"/>
         <rect x="330" y="110" width="250" height="200" rx="8" fill="rgba(255,255,255,0.65)"/>
         <rect x="${w / 2 - 150}" y="${h - 34}" width="300" height="26" rx="8" fill="rgba(255,255,255,0.5)"/>`
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue} 60% 55%)"/><stop offset="1" stop-color="hsl(${(hue + 50) % 360} 50% 25%)"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>${bar}${body}</svg>`)
}

/** A rounded-square app icon with a glyph. */
export function iconSvg(glyph: string, hue: number): string {
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
    <rect x="4" y="4" width="56" height="56" rx="13" fill="hsl(${hue} 60% 50%)"/>
    <text x="32" y="42" font-family="-apple-system, Hiragino Sans, sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${glyph}</text>
  </svg>`)
}

export interface DemoSource {
  id: string
  kind: 'display' | 'window'
  name: string
  app?: string | null
  icon?: string | null
  bounds: { x: number; y: number; width: number; height: number }
  on_screen: boolean
  hue: number
}

export const SOURCES: DemoSource[] = [
  { id: 'display:1', kind: 'display', name: 'Built-in Retina Display', hue: 215, on_screen: true, bounds: { x: 0, y: 0, width: 1512, height: 982 } },
  { id: 'display:2', kind: 'display', name: 'LG UltraFine', hue: 160, on_screen: true, bounds: { x: 1512, y: 0, width: 2560, height: 1440 } },
  { id: 'window:101', kind: 'window', name: 'Steins;Gate', app: 'STEINS;GATE', hue: 350, on_screen: true, bounds: { x: 120, y: 80, width: 1280, height: 720 } },
  { id: 'window:102', kind: 'window', name: '逆転裁判123 成歩堂セレクション', app: 'Ace Attorney Trilogy', hue: 30, on_screen: true, bounds: { x: 200, y: 120, width: 1280, height: 720 } },
  { id: 'window:103', kind: 'window', name: 'YouTube — Google Chrome', app: 'Google Chrome', hue: 5, on_screen: true, bounds: { x: 0, y: 25, width: 1440, height: 900 } },
  { id: 'window:104', kind: 'window', name: 'mpv — 葬送のフリーレン 第12話.mkv', app: 'mpv', hue: 280, on_screen: true, bounds: { x: 300, y: 100, width: 1280, height: 720 } },
  { id: 'window:105', kind: 'window', name: 'Kindle — よつばと！ 1', app: 'Kindle', hue: 45, on_screen: false, bounds: { x: 400, y: 60, width: 900, height: 1200 } }
]

const APP_GLYPHS: Record<string, [string, number]> = {
  'STEINS;GATE': ['S', 350],
  'Ace Attorney Trilogy': ['逆', 30],
  'Google Chrome': ['C', 5],
  mpv: ['▶', 280],
  Kindle: ['K', 45]
}

export function appIcon(app: string | null | undefined): string | null {
  if (!app) return null
  const [glyph, hue] = APP_GLYPHS[app] ?? [app.slice(0, 1).toUpperCase(), 200]
  return iconSvg(glyph, hue)
}

// ------------------------------------------------------------------ reader popup

export const POPOVER_SAMPLE = {
  kind: 'loaded' as const,
  term: '世界線',
  entries: [
    {
      expression: '世界線',
      reading: 'せかいせん',
      glossary:
        '<div style="text-align: left;"><ol><li><i>(n)</i> world line (path of an object through spacetime)</li><li><i>(n, colloquial)</i> timeline; alternate reality</li></ol></div>',
      dictionary: 'JMdict (English)',
      frequencies: '<ul><li>JPDB: 14523</li><li>Novels: 21044</li></ul>',
      'pitch-accents': '<ol><li>せ<span style="text-decoration: overline;">かいせん</span></li></ol>',
      'part-of-speech': 'Noun',
      tags: 'n',
      sentence: '世界線が、ほんのわずかに揺らいだ気がした。'
    },
    {
      expression: '世界',
      reading: 'せかい',
      glossary:
        '<div style="text-align: left;"><ol><li><i>(n)</i> the world; society; the universe</li><li><i>(n)</i> sphere; circle; realm</li></ol></div>',
      dictionary: 'JMdict (English)',
      frequencies: '<ul><li>JPDB: 198</li></ul>',
      'part-of-speech': 'Noun',
      tags: 'n, P'
    }
  ],
  audioMedia: [],
  dictionaryMedia: [],
  sentence: '世界線が、ほんのわずかに揺らいだ気がした。',
  audioAutoplay: false,
  audioVolume: 0.9,
  ankiConfig: null,
  baseUrl: 'http://127.0.0.1:19633'
}

/**
 * The example game every demo surface shows: the dev preview harness (`demo-data.ts` seeds the
 * Log's "Steins;Gate" session from `lines`) and the marketing site's live demo
 * (`site/src/demo/`, which plays the `play` lines in a synthetic visual novel, segments them with
 * `tokens`, and looks words up in `vocab`).
 *
 * TO SWAP THE EXAMPLE GAME, EDIT ONLY THIS FILE:
 *   - `title` / `subtitle` / `app`: the session and window names shown in the Log and the stage.
 *   - `lines`: the transcript, oldest first. Lines with `play: true` are the ones the site's game
 *     shows in its dialogue box, in order; give them `speaker` (omit for narration) and `tokens`
 *     (the line split into words, punctuation included, so `tokens.join('') === text`). A token is
 *     either a string, looked up in `vocab` as-is, or `{ text, word }` when the surface form is
 *     inflected (`{ text: '暑かった', word: '暑い' }`). `focus` names the word the demo opens the
 *     dictionary popup on for that line.
 *   - `vocab`: a tiny dictionary keyed by dictionary form: reading, 1–3 plain-English glosses, and
 *     an optional part of speech. Every `focus` and every word you want boxed must be here.
 *   - `scene`: colours for the synthetic background art (sky gradient, skyline, accent glow).
 *
 * All Japanese lines are original fan-written text, not quotations from the game's script; glosses
 * are our own. Keep this module dependency-free: the site type-checks and bundles it too.
 */

export interface DemoToken {
  /** The characters as they appear in the line. */
  text: string
  /** The `vocab` key (dictionary form) it looks up. */
  word: string
}

export interface DemoLine {
  text: string
  /** Speaker name shown on the dialogue box; omit for narration. */
  speaker?: string
  /** Shown in the site's game dialogue box, in order. */
  play?: boolean
  /** The line split into words (see the header). Strings are looked up in `vocab` as-is. */
  tokens?: (string | DemoToken)[]
  /** The `vocab` word the demo opens the popup on. */
  focus?: string
  /** Cached translation (the Log shows it when `showTranslation`). */
  translation?: string
  showTranslation?: boolean
  /** Cached explanation, markdown (the Log's Explain view). */
  explanation?: string
}

export interface DemoVocab {
  reading: string
  meanings: string[]
  pos?: string
}

export interface DemoScene {
  /** Sky gradient, top to horizon. */
  sky: [string, string, string]
  /** Skyline silhouette fill and the lit-window colour. */
  skyline: string
  windows: string
  /** A soft glow on the horizon (sunset, neon). */
  glow: string
  /** One-line mood note for whoever redraws the scene. */
  mood: string
}

export interface DemoContent {
  title: string
  subtitle: string
  /** The game's process / app name, as the source picker would show it. */
  app: string
  lines: DemoLine[]
  vocab: Record<string, DemoVocab>
  scene: DemoScene
}

export const DEMO_CONTENT: DemoContent = {
  title: 'Steins;Gate',
  subtitle: 'Chapter 3 — the phone microwave (name subject to change).',
  app: 'STEINS;GATE',
  scene: {
    sky: ['#1b1838', '#5b2f5e', '#e0875a'],
    skyline: '#120f22',
    windows: '#ffd58a',
    glow: '#ff9a62',
    mood: 'Akihabara at dusk seen from a cramped rooftop lab: violet sky, warm horizon, neon windows.'
  },
  lines: [
    {
      text: '秋葉原の夏は、今年も容赦なく暑かった。',
      play: true,
      tokens: ['秋葉原', 'の', '夏', 'は', '、', '今年', 'も', '容赦なく', { text: '暑かった', word: '暑い' }, '。'],
      focus: '容赦なく'
    },
    { text: '「フゥーハハハ！　我が名は鳳凰院凶真！　狂気のマッドサイエンティストだ！」' },
    { text: '「オカリン、また独り言言ってる〜」' },
    {
      text: 'まゆりはいつものように、のんびりとした笑顔でバナナを頬張っていた。',
      translation: 'Mayuri was munching on a banana with her usual easygoing smile.',
      showTranslation: false
    },
    { text: 'ラジ館の屋上に、人工衛星のようなものが突き刺さっている。' },
    { text: '「……あなた、さっき私に何か言おうとしてたわよね？」' },
    {
      text: '「牧瀬紅莉栖。十八歳にして論文がサイエンス誌に載った天才少女だ」',
      translation:
        '"Makise Kurisu. A genius girl whose paper was published in Science at just eighteen."',
      showTranslation: true
    },
    {
      text: '「助手よ、コーヒーを淹れてくれたまえ」',
      speaker: '岡部',
      play: true,
      tokens: ['「', '助手', 'よ', '、', 'コーヒー', 'を', { text: '淹れて', word: '淹れる' }, 'くれたまえ', '」'],
      focus: '淹れる'
    },
    {
      text: '「誰が助手よ！」',
      speaker: '紅莉栖',
      play: true,
      tokens: ['「', '誰', 'が', '助手', 'よ', '！', '」'],
      focus: '助手'
    },
    { text: '電話レンジ（仮）の扉が開くと、中のバナナはゲル状に変化していた。' },
    {
      text: '「これは……ただの電子レンジじゃない。時間を超えてメールを送れる装置なのかもしれない」',
      explanation:
        '**Translation:** "This... isn\'t just a microwave. It might be a device that can send mail across time."\n\n- **ただの〜じゃない** — "not merely a ~".\n- **かもしれない** — speculative "might be".'
    },
    {
      text: 'ダルはモニターから目を離さずに、キーボードを叩き続けている。',
      play: true,
      tokens: [
        'ダル', 'は', 'モニター', 'から', '目', 'を', { text: '離さずに', word: '離す' }, '、',
        'キーボード', 'を', { text: '叩き', word: '叩く' }, '続けている', '。'
      ],
      focus: '叩く'
    },
    { text: '「オカリン、それってSERNにハッキングするってこと？　マジで？」' },
    {
      text: '世界線が、ほんのわずかに揺らいだ気がした。',
      play: true,
      tokens: [
        '世界線', 'が', '、', 'ほんの', { text: 'わずかに', word: 'わずか' }, { text: '揺らいだ', word: '揺らぐ' },
        { text: '気がした', word: '気がする' }, '。'
      ],
      focus: '世界線'
    },
    { text: '「エル・プサイ・コングルゥ」' }
  ],
  vocab: {
    秋葉原: { reading: 'あきはばら', meanings: ['Akihabara, Tokyo’s electronics and anime district'], pos: 'Place name' },
    容赦なく: { reading: 'ようしゃなく', meanings: ['mercilessly', 'without letting up'], pos: 'Adverb' },
    暑い: { reading: 'あつい', meanings: ['hot (weather, air)', 'sweltering'], pos: 'い-adjective' },
    助手: { reading: 'じょしゅ', meanings: ['assistant', 'helper', 'lab assistant'], pos: 'Noun' },
    コーヒー: { reading: 'こーひー', meanings: ['coffee'], pos: 'Noun' },
    淹れる: { reading: 'いれる', meanings: ['to make, to brew (tea, coffee)', 'to pour'], pos: 'Ichidan verb' },
    誰: { reading: 'だれ', meanings: ['who', 'somebody (with か)'], pos: 'Pronoun' },
    モニター: { reading: 'もにたー', meanings: ['monitor, display'], pos: 'Noun' },
    離す: { reading: 'はなす', meanings: ['to take (one’s eyes) off', 'to let go of', 'to separate'], pos: 'Godan verb' },
    キーボード: { reading: 'きーぼーど', meanings: ['keyboard'], pos: 'Noun' },
    叩く: { reading: 'たたく', meanings: ['to hit, to tap', 'to type away (at keys)'], pos: 'Godan verb' },
    世界線: { reading: 'せかいせん', meanings: ['world line', 'timeline, alternate reality (colloquial)'], pos: 'Noun' },
    わずか: { reading: 'わずか', meanings: ['slight, tiny', 'only a little'], pos: 'な-adjective' },
    揺らぐ: { reading: 'ゆらぐ', meanings: ['to sway, to waver', 'to flicker'], pos: 'Godan verb' },
    気がする: { reading: 'きがする', meanings: ['to have a feeling that', 'to sense'], pos: 'Expression' }
  }
}

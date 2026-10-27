/**
 * DEV-ONLY: the voices of the Steins;Gate demo's spoken lines (demo-content.ts), read by
 * ElevenLabs (eleven_v4, the app's default voice) into demo-audio/sg-<n>.mp3, 64 kbps. The
 * preview's Log plays them as the lines' sentence audio (preview-sentence-audio.ts), in the
 * studio and the site's demo alike.
 */
const FILES = import.meta.glob<string>('./demo-audio/*.mp3', { query: '?url', import: 'default', eager: true })

/** The lines, in the files' order. */
const SPOKEN = [
  '「フゥーハハハ！　我が名は鳳凰院凶真！　狂気のマッドサイエンティストだ！」',
  '「オカリン、また独り言言ってる〜」',
  '「……あなた、さっき私に何か言おうとしてたわよね？」',
  '「牧瀬紅莉栖。十八歳にして論文がサイエンス誌に載った天才少女だ」',
  '「助手よ、コーヒーを淹れてくれたまえ」',
  '「誰が助手よ！」',
  '「これは……ただの電子レンジじゃない。時間を超えてメールを送れる装置なのかもしれない」',
  '「オカリン、それってSERNにハッキングするってこと？　マジで？」',
  '「エル・プサイ・コングルゥ」'
]

/** Text as compared: no brackets or spaces, and the long-vowel marks the Log may spell apart. */
const plain = (text: string): string => text.replace(/[「」『』\s\u3000]/g, '').replace(/[ゥー〜]/g, '')

const BY_TEXT = new Map(
  SPOKEN.flatMap((text, i) => {
    const url = FILES[`./demo-audio/sg-${i + 1}.mp3`]
    return url ? [[plain(text), url] as const] : []
  })
)

/** The voice of a demo line, by its text: its MP3's URL. */
export function demoVoice(text: string): string | undefined {
  return BY_TEXT.get(plain(text))
}

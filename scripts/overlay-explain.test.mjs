/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain JS test. */
/**
 * Explain on the overlay (ui/explain-screen.ts, ui/overlay-explain.js): the text on screen is the
 * sentence, the Log's earlier lines its scene, and the provider, model and prompt are the Log's.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { load } from './load.mjs'

const screen = await load('explain-screen.ts')
const prompt = await load('explain-prompt.ts')
const { inline, markdownBlocks } = await load('explain-markdown.ts')

const text = (t) => ({ kind: 'text', text: t })

test('an answer reads as paragraphs (line breaks kept), headings and lists', () => {
  const answer = [
    '**Translation:** "Let\'s go."',
    '',
    '## Grammar',
    '- **行く** + **ぞ**: a rough, assertive ending',
    '  used mostly by men',
    '- *Omitted subject*: we',
    '',
    '1. one',
    '2) two',
    'first line',
    'second line'
  ].join('\n')
  assert.deepEqual(markdownBlocks(answer), [
    {
      kind: 'p',
      children: [{ kind: 'strong', children: [text('Translation:')] }, text(' "Let\'s go."')]
    },
    { kind: 'h', level: 2, children: [text('Grammar')] },
    {
      kind: 'ul',
      items: [
        [
          { kind: 'strong', children: [text('行く')] },
          text(' + '),
          { kind: 'strong', children: [text('ぞ')] },
          text(': a rough, assertive ending'),
          text(' '),
          text('used mostly by men')
        ],
        [{ kind: 'em', children: [text('Omitted subject')] }, text(': we')]
      ]
    },
    { kind: 'ol', items: [[text('one')], [text('two')]] },
    { kind: 'p', children: [text('first line'), { kind: 'br' }, text('second line')] }
  ])
})

test('code, quotes and rules; markup in an answer stays text', () => {
  assert.deepEqual(markdownBlocks('```\n<b>x</b>\n```\n---\n> quoted `a*b*`'), [
    { kind: 'pre', text: '<b>x</b>' },
    { kind: 'p', children: [text('quoted '), { kind: 'code', text: 'a*b*' }] }
  ])
  assert.deepEqual(inline('<img src=x onerror=alert(1)>'), [text('<img src=x onerror=alert(1)>')])
})

test('a mark still streaming in shows as written', () => {
  assert.deepEqual(inline('**行'), [text('**行')])
  assert.deepEqual(inline('2 * 3 = 6'), [text('2 * 3 = 6')])
})

test('the text on screen is the sentence and the earlier Log lines its scene, oldest first', () => {
  // log_recent is newest first, and has the screen's own lines at its head.
  const recent = [{ text: '「行くぞ」' }, { text: '彼は言った。' }, { text: 'B' }, { text: 'A' }]
  const request = screen.explainRequest(['彼は言った。', '「行くぞ」'], recent, {}, 'ja')
  assert.equal(request.sentence, '彼は言った。\n「行くぞ」')
  assert.equal(request.context, 'A\nB')
  assert.equal(request.prompt, prompt.explainPromptFor(undefined, 'ja', 'A\nB', '彼は言った。\n「行くぞ」'))
})

test('text read with OCR is given as one run where it wraps on screen', () => {
  // meikiocr reads a bubble's two lines with a break between them; the Log has the same text.
  const wrapped = '最新の詳しい情報は、紅白特設サイトで公\n開中!!'
  const recent = [
    { text: wrapped, source: 'ocr' },
    { text: 'la casa\nazul', source: 'ocr' },
    { text: '一行目\n二行目', source: 'hook' }
  ]
  const request = screen.explainRequest([wrapped], recent, {}, 'ja', '公開中', { ocr: true })
  assert.equal(request.sentence, '最新の詳しい情報は、紅白特設サイトで公開中!!')
  // The screen's own line is still left out of the scene; Latin words keep a space; a hooked
  // line's breaks are the game's own and stay.
  assert.equal(request.context, '一行目\n二行目\nla casa azul')
  // A word across the break is found and marked whole.
  assert.ok(request.prompt.includes('サイトで<TO EXPLAIN>公開中</TO EXPLAIN>!!'))
  // Not read with OCR (the Text Hooker's line): as the game gave it.
  assert.equal(screen.explainRequest(['一行目\n二行目'], [], {}, 'ja').sentence, '一行目\n二行目')
})

test('the scene is at most the 15 lines before, and says so when there are none', () => {
  const recent = Array.from({ length: 30 }, (_, i) => ({ text: `line ${30 - i}` }))
  const request = screen.explainRequest(['now'], recent, {}, 'ja')
  const lines = request.context.split('\n')
  assert.equal(lines.length, screen.CONTEXT_LINES)
  assert.equal(lines.at(-1), 'line 30')
  assert.equal(lines[0], 'line 16')
  assert.equal(screen.explainRequest(['now'], [], {}, 'ja').context, '(no previous lines available)')
  assert.equal(screen.explainRequest(['now'], null, {}, 'ja').context, '(no previous lines available)')
})

test('a highlighted word is explained first, after whatever prompt is used', () => {
  const plain = screen.explainRequest(['一緒に散歩しませんか？'], [], {}, 'ja')
  const focused = screen.explainRequest(['一緒に散歩しませんか？'], [], {}, 'ja', ' ませんか ')
  assert.equal(plain.word, null)
  assert.equal(focused.word, 'ませんか')
  const marked = plain.prompt.replace('ませんか', '<TO EXPLAIN>ませんか</TO EXPLAIN>')
  assert.equal(focused.prompt, `${marked}\n\n${screen.focusInstruction('ませんか')}`)
  assert.match(focused.prompt, /marked as <TO EXPLAIN>ませんか<\/TO EXPLAIN>/)
  assert.match(focused.prompt, /FOCUS: The reader highlighted "ませんか"/)
  const own = { explainPrompt: 'Explain {{sentence}}' }
  assert.match(screen.explainRequest(['s'], [], own, 'ja', 'w').prompt, /^Explain s\n\nFOCUS: .*"w"/)
  assert.equal(screen.explainRequest(['s'], [], {}, 'ja', '  ').word, null)
  // The reader's own instruction for a highlighted word, with {{word}} filled in; blank is the default.
  const focusOwn = { explainPrompt: 'Explain {{sentence}}', explainFocusPrompt: 'Start with {{word}}.' }
  assert.equal(screen.explainRequest(['s'], [], focusOwn, 'ja', 'w').prompt, 'Explain s\n\nStart with w.')
  const blank = { ...focusOwn, explainFocusPrompt: '  ' }
  assert.match(screen.explainRequest(['s'], [], blank, 'ja', 'w').prompt, /FOCUS: .*"w"/)
})

test('text read with OCR says it may hold misreadings; hooked text does not', () => {
  // What separates the prompt's parts.
  const gap = '\n\n'
  const hooked = screen.explainRequest(['一緒に散歩しませんか？'], [], {}, 'ja')
  assert.equal(hooked.ocr, false)
  assert.ok(!hooked.prompt.includes(screen.OCR_NOTE))
  const read = screen.explainRequest(['一緒に散歩しませんか？'], [], {}, 'ja', null, { ocr: true })
  assert.equal(read.ocr, true)
  assert.ok(read.prompt.endsWith(gap + screen.OCR_NOTE))
  // With a word, the note comes after the prompt and before the word's instruction.
  const word = screen.explainRequest(['一緒に散歩しませんか？'], [], {}, 'ja', 'ませんか', { ocr: true })
  assert.ok(word.prompt.includes(gap + screen.OCR_NOTE + gap + 'FOCUS: '))
  // The reader's own prompt gets it too.
  const own = screen.explainRequest(['s'], [], { explainPrompt: 'Explain {{sentence}}' }, 'ja', null, { ocr: true })
  assert.equal(own.prompt, 'Explain s' + gap + screen.OCR_NOTE)
})

test("the Log's own Explain adds the same note for a line read with OCR", async () => {
  const log = await readFile(new URL('../frontend/texthooker/lib/explain.ts', import.meta.url), 'utf8')
  assert.match(log, /import \{ OCR_NOTE \} from '@ui\/explain-screen'/)
  assert.match(log, /line\.source === 'ocr' \? `\$\{prompt\}\\n\\n\$\{OCR_NOTE\}` : prompt/)
})

test('the highlighted word is marked where it is in the sentence', () => {
  const line = 'En la fiesta del fin de semana pasado'
  // "de" is also the start of "del": what is drawn after it picks the right one.
  const de = { text: 'de', before: '', after: ' semana pasado' }
  assert.equal(screen.locateWord(line, 'de', de.before, de.after), line.indexOf('de semana'))
  assert.equal(screen.locateWord(line, 'de', '', 'l fin de'), line.indexOf('del'))
  assert.equal(screen.locateWord(line, 'xyz'), -1)
  const request = screen.explainRequest([line], [], {}, 'es', de)
  assert.equal(request.word, 'de')
  assert.equal(request.sentence, line)
  assert.ok(request.prompt.includes('En la fiesta del fin <TO EXPLAIN>de</TO EXPLAIN> semana pasado'))
  assert.match(
    request.prompt,
    /highlighted "de" in the target sentence\. Where it was found there, it is marked as <TO EXPLAIN>de<\/TO EXPLAIN>;/
  )
  // Not found in the sentence: asked about by its text alone, nothing marked.
  const lost = screen.explainRequest([line], [], {}, 'es', 'casa')
  assert.ok(lost.prompt.includes(`TARGET SENTENCE:\n${line}\n`))
  assert.match(lost.prompt, /highlighted "casa" in the target sentence\. Where it was found/)
  const ja = '彼は言った。彼女は笑った。'
  assert.equal(screen.locateWord(ja, '彼', '', '女は'), ja.indexOf('彼女'))
})

test('the answer sits right under its line, or over it when there is no room below', () => {
  const viewport = { width: 1280, height: 720 }
  // A dialogue line high on screen: under it, centred on it at the card's own width, its notch on
  // the word.
  const line = { x: 200, y: 100, width: 600, height: 40 }
  const under = screen.placeExplanation(line, { x: 300, y: 100, width: 40, height: 40 }, null, viewport)
  assert.deepEqual(under, { side: 'below', left: 180, width: 640, top: 150, bottom: null, maxHeight: 480, caret: 140 })
  // A short line gets the same width, not one sized to it.
  const short = screen.placeExplanation({ x: 600, y: 100, width: 80, height: 40 }, null, null, viewport)
  assert.equal(short.width, 640)
  assert.equal(short.left, 640 - 320)
  // The usual visual novel's box at the bottom: over it, its bottom edge above the text and the
  // furigana OCR leaves out of its boxes.
  const box = { x: 100, y: 560, width: 1080, height: 120 }
  const over = screen.placeExplanation(box, null, null, viewport)
  assert.deepEqual(over, {
    side: 'above',
    left: 320,
    width: 640,
    top: null,
    bottom: 720 - (560 - 10 - 24),
    maxHeight: 480,
    caret: 320
  })
  // Text by the screen's edge: the card is kept on screen, its notch still on the text.
  const corner = screen.placeExplanation({ x: 1250, y: 10, width: 20, height: 20 }, null, null, viewport)
  assert.equal(corner.width, 640)
  assert.equal(corner.left, 1280 - 640 - 8)
  assert.equal(corner.caret, 640 - 18)
  // A narrow screen: as wide as it allows.
  assert.equal(screen.placeExplanation(line, null, null, { width: 500, height: 720 }).width, 484)
})

test('the anchor is the line around the word, not matching scraps across the screen', () => {
  // A dialogue box's two lines, each in word boxes, low on a 1280×720 screen; and short boxes
  // elsewhere (a menu's "！", a particle in a sign) whose text is also in the line.
  const line1 = [
    { x: 100, y: 560, width: 120, height: 40 },
    { x: 226, y: 560, width: 80, height: 40 },
    { x: 312, y: 560, width: 200, height: 40 }
  ]
  const line2 = [
    { x: 100, y: 612, width: 160, height: 40 },
    { x: 266, y: 612, width: 240, height: 40 }
  ]
  const scraps = [
    { x: 1180, y: 20, width: 30, height: 30 },
    { x: 40, y: 200, width: 24, height: 24 },
    { x: 900, y: 360, width: 40, height: 40 }
  ]
  const boxes = [...scraps, ...line1, ...line2]
  // The word is in the second line's last box.
  const seed = screen.boxAt(boxes, 400, 630)
  assert.equal(seed, boxes.indexOf(line2[1]))
  const anchor = screen.clusterBoxes(boxes, seed)
  assert.deepEqual(anchor, { x: 100, y: 560, width: 412, height: 92 })
  // So the card goes right over the dialogue box, not to the bottom of the screen.
  const card = screen.placeExplanation(anchor, null, null, { width: 1280, height: 720 })
  assert.equal(card.side, 'above')
  assert.ok(card.bottom > 720 - 560)
  // A scrap far from everything is only itself: nothing across the screen joins it.
  assert.deepEqual(screen.clusterBoxes(boxes, 0), scraps[0])
})

test('the word pointed at is the word under the caret, not the whole box OCR read', () => {
  const line = 'a. En la fiesta del fin de semana pasado'
  const word = (offset, language = 'es') => {
    const span = screen.wordSpanAt(line, offset, language)
    return span && line.slice(span.start, span.end)
  }
  const s = line.indexOf('semana')
  assert.equal(word(s), 'semana')
  assert.equal(word(s + 3), 'semana')
  // Just past its last letter (the pointer on its right half): still on it.
  assert.equal(word(s + 'semana'.length), 'semana')
  assert.equal(word(line.indexOf('del') + 1), 'del')
  // On a space between words, nothing.
  assert.equal(word(line.indexOf(' En')), null)
  assert.equal(screen.wordSpanAt('', 0, 'es'), null)
  // Japanese, which puts no spaces between words.
  const ja = '海まで行こう'
  const span = screen.wordSpanAt(ja, 0, 'ja')
  assert.ok(span && span.end > 0 && span.end < ja.length)
})

test('a word on a page of text is anchored by its own line, not its paragraph', () => {
  // Three lines of a paragraph, 24 px apart: the middle line's words, and one far along it.
  const words = [
    { x: 100, y: 100, width: 40, height: 20 },
    { x: 150, y: 124, width: 30, height: 20 },
    { x: 186, y: 124, width: 60, height: 20 },
    { x: 100, y: 124, width: 44, height: 20 },
    { x: 100, y: 148, width: 50, height: 20 },
    { x: 600, y: 124, width: 40, height: 20 }
  ]
  assert.deepEqual(screen.lineBoxes(words, 1), { x: 100, y: 124, width: 146, height: 20 })
  // The whole paragraph, for comparison.
  assert.equal(screen.clusterBoxes(words, 1).height, 68)
  assert.equal(screen.lineBoxes(words, -1), null)
})

test('a bubble of columns is one anchor; a point outside every box takes the nearest', () => {
  const columns = [
    { x: 787, y: 95, width: 41, height: 112 },
    { x: 741, y: 95, width: 41, height: 112 },
    { x: 695, y: 95, width: 41, height: 169 },
    { x: 264, y: 392, width: 41, height: 112 }
  ]
  assert.deepEqual(screen.clusterBoxes(columns, 0), { x: 695, y: 95, width: 133, height: 169 })
  assert.equal(screen.boxAt(columns, 280, 380), 3)
  assert.equal(screen.boxAt([], 0, 0), -1)
  assert.equal(screen.clusterBoxes(columns, -1), null)
})

test('beside a tall column of vertical text, and over some text only when nothing has room', () => {
  const viewport = { width: 1280, height: 720 }
  // A manga bubble running most of the page's height, on its left: to its right, notch on the word.
  const bubble = { x: 100, y: 120, width: 80, height: 480 }
  const beside = screen.placeExplanation(bubble, { x: 120, y: 300, width: 40, height: 40 }, null, viewport)
  assert.deepEqual(beside, { side: 'right', left: 190, width: 420, top: 280, bottom: null, maxHeight: 432, caret: 40 })
  // On the right of the page: to its left.
  const rightBubble = { x: 1100, y: 120, width: 80, height: 480 }
  const leftOf = screen.placeExplanation(rightBubble, null, null, viewport)
  assert.equal(leftOf.side, 'left')
  assert.equal(leftOf.left, 1100 - 10 - 420)
  // Text everywhere: the side with the most room, given enough height to read, kept on screen.
  const page = screen.placeExplanation({ x: 20, y: 60, width: 1240, height: 560 }, null, null, viewport)
  assert.equal(page.side, 'below')
  assert.equal(page.maxHeight, 240)
  assert.equal(page.top, 720 - 8 - 240)
})

test('with nowhere to point, the card goes over the top of the source', () => {
  const lost = screen.placeExplanation(
    null,
    null,
    { x: 40, y: 60, width: 800, height: 600 },
    { width: 1280, height: 720 }
  )
  assert.deepEqual(lost, { side: 'below', left: 120, width: 640, top: 68, bottom: null, maxHeight: 480, caret: 320 })
})

test('no text on screen asks for nothing', () => {
  assert.equal(screen.explainRequest(null, [{ text: 'A' }], {}, 'ja'), null)
  assert.equal(screen.explainRequest(['  ', ''], [{ text: 'A' }], {}, 'ja'), null)
})

test("the Log's own prompt is sent as written, and a default one follows the language", () => {
  const own = { explainPrompt: 'Explain {{sentence}} given {{context}}' }
  assert.equal(screen.explainRequest(['s'], [{ text: 'c' }], own, 'ko').prompt, 'Explain s given c')
  assert.match(screen.explainRequest(['안녕'], [], {}, 'ko').prompt, /expert Korean tutor/)
})

test("the overlay's request ids stay clear of the Log's, and it cancels only its own run", async () => {
  const source = await readFile(new URL('../ui/overlay-explain.js', import.meta.url), 'utf8')
  assert.match(source, /REQUEST_BASE = 2 \*\* 40/)
  assert.match(source, /invoke\('explain_cancel', \{ requestId/)
  const log = await readFile(new URL('../frontend/texthooker/lib/explain.ts', import.meta.url), 'utf8')
  assert.match(log, /invoke\('explain_cancel', \{ requestId \}\)/)
})

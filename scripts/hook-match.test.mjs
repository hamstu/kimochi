import { test } from 'node:test'
import assert from 'node:assert/strict'
import { load } from './load.mjs'
const { placeHookedLine, splitAcrossLines } = await load('hook-match.ts')

/** An OCR group with one line polygon per text line, stacked from `y`. */
const group = (id, lines, x, y, size = 30) => ({
  id,
  text: lines.join('\n'),
  orientation: 'horizontal',
  bbox: [x, y, x + Math.max(...lines.map((l) => l.length)) * size, y + lines.length * size * 1.4],
  linePolygons: lines.map((l, i) => [
    [x, y + i * size * 1.4],
    [x + l.length * size, y + i * size * 1.4],
    [x + l.length * size, y + i * size * 1.4 + size],
    [x, y + i * size * 1.4 + size]
  ]),
  lines
})

// A nameplate over a two-line dialogue box, the HUD to the right, misreads
// in the OCR (a dropped 、).
const screen = () => [
  group('hud', ['AUTO SKIP LOG'], 1290, 820, 20),
  group('name', ['サクラ'], 430, 840),
  group('dialogue', ['「旅人は夢だけの記録となってもなおその町に集まり', 'お客様の約束に駆けつけたのです」'], 430, 880),
  group('menu', ['回想', '音楽'], 60, 50, 38)
]
const HOOKED = '「旅人は夢だけの記録となってもなおその町に集まり、\n　お客様の約束に駆けつけたのです」'

test('the hooked line replaces the dialogue box, not the nameplate, HUD or menu', () => {
  const placed = placeHookedLine(screen(), HOOKED)
  assert.equal(placed.matched, 'hook:dialogue')
  const box = placed.groups.find((g) => g.id === placed.matched)
  assert.deepEqual(box.lines, [
    '「旅人は夢だけの記録となってもなおその町に集まり、',
    '　お客様の約束に駆けつけたのです」'
  ])
  assert.deepEqual(placed.groups.map((g) => g.id).sort(), ['hook:dialogue', 'hud', 'menu', 'name'])
})

test('OCR misreads still place the line, and the exact hooked text is drawn', () => {
  const groups = [group('d', ['今日は描と一緒に学校へ行きます', '青い空と静かな海が好きです'], 50, 500)]
  const placed = placeHookedLine(groups, '今日は猫と一緒に学校へ行きます。青い空と静かな海が好きです。')
  assert.equal(placed.matched, 'hook:d')
  assert.deepEqual(placed.groups[0].lines, ['今日は猫と一緒に学校へ行きます。', '青い空と静かな海が好きです。'])
})

test('a dialogue box OCR split in two is matched as one', () => {
  const groups = [
    group('a', ['駅で傘を忘れちゃったんだけど'], 430, 880),
    group('b', ['その後の帰り道がかなり大変で覚えてない'], 430, 922)
  ]
  const placed = placeHookedLine(groups, '駅で傘を忘れちゃったんだけど、\nその後の帰り道がかなり大変で、覚えてない。')
  assert.equal(placed.matched, 'hook:a+b')
  assert.equal(placed.groups.length, 1)
  assert.deepEqual(placed.groups[0].lines, [
    '駅で傘を忘れちゃったんだけど、',
    'その後の帰り道がかなり大変で、覚えてない。'
  ])
})

test('a line that is only some lines of one block (two paragraphs read as one) is just those lines', () => {
  const groups = [
    group(
      'page',
      [
        '小さな町には大きな川と古い橋があって、',
        '朝になると多くの人がその橋を渡っている。',
        '言うまでもなく、雨の日には足元に気をつけなければならない。',
        '町の人たちは必ず、少し遠回りをして駅へ向かっている。'
      ],
      545,
      200
    )
  ]
  const placed = placeHookedLine(
    groups,
    '言うまでもなく、雨の日には足元に気をつけなければならない。町の人たちは必ず、少し遠回りをして駅へ向かっている。'
  )
  assert.equal(placed.matched, 'hook:page#2-3')
  assert.equal(placed.recall, 1)
  assert.equal(placed.precision, 1)
  const box = placed.groups.find((g) => g.id === placed.matched)
  assert.equal(box.bbox[1], 200 + 2 * 30 * 1.4)
  assert.deepEqual(box.lines, [
    '言うまでもなく、雨の日には足元に気をつけなければならない。',
    '町の人たちは必ず、少し遠回りをして駅へ向かっている。'
  ])
})

test('nothing on screen is the line: no match, groups untouched', () => {
  const groups = screen()
  const placed = placeHookedLine(groups, '明日は友達と日本語の本を読みます。')
  assert.equal(placed.matched, null)
  assert.equal(placed.groups, groups)
})

test('the nameplate line itself matches only the nameplate', () => {
  const placed = placeHookedLine(screen(), 'サクラ')
  assert.equal(placed.matched, 'hook:name')
})

test('splitting keeps every character and puts punctuation with the earlier line', () => {
  assert.deepEqual(splitAcrossLines('ああ、いい。うう', ['ああ', 'いいうう']), ['ああ、', 'いい。うう'])
  assert.deepEqual(splitAcrossLines('一行', ['一行']), ['一行'])
})

const { hookAnnotations, annotationGroups } = await load('hook-match.ts')
const rect = (x0, y0, x1, y1) => ({
  vertices: [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 }
  ]
})
const aggregate = { description: 'all', granularity: 'aggregate', boundingPoly: rect(0, 0, 1, 1) }

test('block annotations: only the hooked block is drawn, with the hooked text on its lines', () => {
  const annotations = [
    aggregate,
    { description: 'サクラ', granularity: 'block', groupId: 'g1', boundingPoly: rect(430, 840, 520, 870) },
    {
      description: '「うっ……ま、だ……！」',
      granularity: 'block',
      groupId: 'g2',
      inkMargin: [0.1, 0, 0.05, 0],
      linePolygons: [
        [
          [430, 880],
          [700, 880],
          [700, 910],
          [430, 910]
        ]
      ],
      boundingPoly: rect(430, 880, 700, 910)
    },
    { description: 'AUTO SKIP LOG', granularity: 'block', groupId: 'g3', boundingPoly: rect(1290, 820, 1600, 845) }
  ]
  const hooked = hookAnnotations(annotations, '「うっ……ま、だ……！」')
  assert.equal(hooked.annotations.length, 1)
  assert.equal(hooked.annotations[0].description, '「うっ……ま、だ……！」')
  assert.deepEqual(hooked.annotations[0].inkMargin, [0.1, 0, 0.05, 0])
  assert.deepEqual(hooked.box, [430, 880, 700, 910])
})

test('word fragments of one group are gathered into rows before matching', () => {
  const word = (t, x0, y0) => ({
    description: t,
    granularity: 'fragment',
    groupId: 'w',
    boundingPoly: rect(x0, y0, x0 + t.length * 30, y0 + 30)
  })
  const annotations = [aggregate, word('今日は', 50, 500), word('猫と学校へ', 140, 502), word('行きます', 50, 545)]
  const groups = annotationGroups(annotations)
  assert.deepEqual(groups[0].lines, ['今日は猫と学校へ', '行きます'])
  const hooked = hookAnnotations(annotations, '今日は猫と学校へ行きます。')
  assert.deepEqual(hooked.annotations[0].lineTexts, ['今日は猫と学校へ', '行きます。'])
})

test('no match draws nothing', () => {
  const hooked = hookAnnotations(
    [aggregate, { description: 'AUTO SKIP LOG', granularity: 'block', boundingPoly: rect(0, 0, 100, 20) }],
    '今日は猫と学校へ行きます。'
  )
  assert.deepEqual(hooked.annotations, [])
  assert.equal(hooked.box, null)
})

const { splitSpeaker } = await load('hook-match.ts')

test('a line its speaker leads splits into name and quote; narration does not', () => {
  assert.deepEqual(splitSpeaker('アキ「―――海辺の町、ミナト・ハーバー」'), {
    name: 'アキ',
    body: '「―――海辺の町、ミナト・ハーバー」'
  })
  assert.deepEqual(splitSpeaker('【アキ】「はい」'), { name: 'アキ', body: '「はい」' })
  assert.deepEqual(splitSpeaker('アキ：『はい』'), { name: 'アキ', body: '『はい』' })
  assert.deepEqual(splitSpeaker('女性の声12「ふふっ。もう、ちょっと……待ってよ……」'), {
    name: '女性の声12',
    body: '「ふふっ。もう、ちょっと……待ってよ……」'
  })
  assert.deepEqual(splitSpeaker('？？？「誰？」'), { name: '？？？', body: '「誰？」' })
  assert.equal(splitSpeaker('「はい」'), null)
  assert.equal(splitSpeaker('彼は「はい」と言った。'), null)
  assert.equal(splitSpeaker('そう、「はい」'), null)
  assert.equal(splitSpeaker('壁の内側には、街があった。'), null)
})

test('a name the game sends after the quote, on a line of its own, splits too', () => {
  const thought = '（ん？　あ、鍵が落ちてる……！\n　もしかして、さっきの人のかな……？）'
  assert.deepEqual(splitSpeaker(`${thought}\n蒼`), { name: '蒼', body: thought, after: true })
  assert.deepEqual(splitSpeaker('「はい」\n【アキ】'), { name: 'アキ', body: '「はい」', after: true })
  assert.deepEqual(splitSpeaker('「はい」　女性の声12'), { name: '女性の声12', body: '「はい」', after: true })
  assert.equal(splitSpeaker('「はい」と言った。'), null)
  assert.equal(splitSpeaker('「はい」\nそう言って、彼は笑った。'), null)
  assert.equal(splitSpeaker('「はい」'), null)
})

// A nameplate over the text box: the scene reads the two as one passage, or apart.
const DIALOGUE = '「―――海辺の町、ミナト・ハーバー」'
const lines = (id, texts, x, y, size = 30) => ({
  description: texts.join('\n'),
  granularity: 'block',
  groupId: id,
  surface: { ink: 'light', top: '#000', bottom: '#111' },
  lineTexts: texts,
  linePolygons: texts.map((t, i) => [
    [x, y + i * 50],
    [x + t.length * size, y + i * 50],
    [x + t.length * size, y + i * 50 + size],
    [x, y + i * 50 + size]
  ]),
  boundingPoly: rect(x, y, x + Math.max(...texts.map((t) => t.length)) * size, y + (texts.length - 1) * 50 + size)
})

test('a speaker shown on a nameplate: the card is the quote, the name is OCR text on the plate', () => {
  for (const annotations of [
    [aggregate, lines('p', ['アキ', DIALOGUE], 600, 1300)],
    [aggregate, lines('n', ['アキ'], 600, 1300), lines('d', [DIALOGUE], 545, 1350)]
  ]) {
    const hooked = hookAnnotations(annotations, `アキ${DIALOGUE}`)
    assert.equal(hooked.shown, DIALOGUE)
    assert.equal(hooked.annotations[0].description, DIALOGUE)
    assert.equal(hooked.box[1], 1350)
    assert.equal(hooked.names.length, 1)
    assert.equal(hooked.names[0].description, 'アキ')
    assert.equal(hooked.nameBox[1], 1300)
  }
})

test('a name the game sends after the quote: the same card and nameplate, the plate above or below', () => {
  const quote = ['（ん？　あ、鍵が落ちてる……！', '　もしかして、さっきの人のかな……？）']
  const sent = `${quote.join('\n')}\n蒼`
  for (const [plate, y] of [
    [lines('n', ['蒼'], 600, 1300), 1300],
    [lines('n', ['蒼'], 600, 1460), 1460]
  ]) {
    const hooked = hookAnnotations([aggregate, plate, lines('d', quote, 545, 1350)], sent)
    assert.equal(hooked.shown, quote.join('\n'))
    assert.equal(hooked.box[1], 1350)
    assert.equal(hooked.names[0]?.description, '蒼')
    assert.equal(hooked.nameBox[1], y)
  }
  // OCR missed the plate (a lone character often is): still the quote alone, where it is.
  const missed = hookAnnotations([aggregate, lines('d', quote, 545, 1350)], sent)
  assert.equal(missed.shown, quote.join('\n'))
  assert.equal(missed.box[1], 1350)
  assert.deepEqual(missed.names, [])
  // Where the game showed a name before, the name is drawn there, as wide as itself.
  const known = hookAnnotations([aggregate, lines('d', quote, 545, 1350)], sent, { nameAt: [600, 1300, 660, 1330] })
  assert.equal(known.names[0]?.description, '蒼')
  assert.deepEqual(known.names[0].boundingPoly.vertices[0], { x: 600, y: 1300 })
  assert.deepEqual(known.names[0].boundingPoly.vertices[2], { x: 630, y: 1330 })
  assert.equal(known.nameBox, null)
  // Nothing read at all: the card still leaves the name out.
  assert.equal(hookAnnotations([aggregate], sent).shown, quote.join('\n'))
})

test('a name the game shows inline, or narration that looks like a speech, stays whole', () => {
  const inline = hookAnnotations([aggregate, lines('d', [`アキ${DIALOGUE}`], 545, 1350)], `アキ${DIALOGUE}`)
  assert.equal(inline.shown, `アキ${DIALOGUE}`)
  assert.deepEqual(inline.names, [])
  const narration = hookAnnotations(
    [aggregate, lines('d', ['そして「さようなら」'], 545, 1350)],
    'そして「さようなら」'
  )
  assert.equal(narration.shown, 'そして「さようなら」')
  assert.deepEqual(narration.names, [])
})

test('the name elsewhere on screen (a menu, another line) is not the speaker’s', () => {
  const far = hookAnnotations(
    [aggregate, lines('n', ['アキ'], 2400, 100), lines('d', [DIALOGUE], 545, 1350)],
    `アキ${DIALOGUE}`
  )
  assert.equal(far.shown, `アキ${DIALOGUE}`)
  // Where the game showed a name before, it is.
  const known = hookAnnotations(
    [aggregate, lines('n', ['アキ'], 2400, 100), lines('d', [DIALOGUE], 545, 1350)],
    `アキ${DIALOGUE}`,
    { nameAt: [2400, 100, 2460, 130] }
  )
  assert.equal(known.shown, DIALOGUE)
  // A game known to show names apart: the quote alone, even where OCR missed the name.
  const missed = hookAnnotations([aggregate, lines('d', [DIALOGUE], 545, 1350)], `アキ${DIALOGUE}`, { apart: true })
  assert.equal(missed.shown, DIALOGUE)
  assert.deepEqual(missed.names, [])
  assert.equal(missed.box[1], 1350)
})

test('a quote of nothing but dots: the name says where it is, the dots under it the card', () => {
  const annotations = [aggregate, lines('n', ['アキ'], 600, 1300), lines('d', ['……'], 545, 1350)]
  const hooked = hookAnnotations(annotations, 'アキ「……」')
  assert.equal(hooked.shown, '「……」')
  assert.deepEqual(hooked.box, [545, 1350, 605, 1380])
  assert.equal(hooked.names[0].description, 'アキ')
  // OCR missed the dots: the name is still drawn, and the card shows the quote where it is.
  const missed = hookAnnotations([aggregate, lines('n', ['アキ'], 600, 1300)], 'アキ「……」', {
    nameAt: [600, 1300, 660, 1330]
  })
  assert.equal(missed.shown, '「……」')
  assert.equal(missed.box, null)
  assert.equal(missed.names[0].description, 'アキ')
  // Not known yet, nor the dots read: nothing to place it by but the name, so it is not placed.
  assert.equal(hookAnnotations([aggregate, lines('n', ['アキ'], 600, 1300)], 'アキ「……」').box, null)
})

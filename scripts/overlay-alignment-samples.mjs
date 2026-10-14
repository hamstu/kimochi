/**
 * The rendered samples of the overlay alignment corpus (scripts/fixtures/overlay-alignment/):
 * game-style text drawn glyph by glyph in headless Chrome, so where every character truly is is
 * known. Each covers a case the overlay has to line up on: dialogue with tracking, a pixel font
 * blown up 3×, long katakana runs mixed with Latin and digits, small UI text, a large title, and
 * vertical columns.
 */
export const SAMPLES = [
  {
    name: 'dialogue',
    width: 1280,
    height: 720,
    background: '#36513f',
    panels: [{ x: 40, y: 450, width: 1200, height: 240, fill: '#141c5a', stroke: '#d8defe', border: 5, radius: 14 }],
    lines: [
      { text: '「ねえ、今日は一緒に図書館へ行かない？」', font: "'Hiragino Maru Gothic ProN'", size: 36, tracking: 0.12, color: '#fff', x: 80, y: 486 },
      { text: '「ごめん、アルバイトがあるから無理なんだ。」', font: "'Hiragino Maru Gothic ProN'", size: 36, tracking: 0.12, color: '#fff', x: 80, y: 552 },
      { text: '「じゃあ、また明日にしようね。」', font: "'Hiragino Maru Gothic ProN'", size: 36, tracking: 0.12, color: '#fff', x: 80, y: 618 }
    ]
  },
  {
    name: 'pixel',
    width: 1152,
    height: 648,
    pixel: 3,
    background: '#000',
    panels: [{ x: 48, y: 384, width: 1056, height: 228, fill: '#1830a8', stroke: '#ffffff', border: 6, radius: 6 }],
    lines: [
      { text: 'ゆうしゃは　スライムを　たおした！', font: "'Hiragino Sans'", weight: 600, size: 36, monospace: true, tracking: 0.17, color: '#fff', x: 96, y: 420 },
      { text: 'ＨＰが　１２　かいふくした。', font: "'Hiragino Sans'", weight: 600, size: 36, monospace: true, tracking: 0.17, color: '#fff', x: 96, y: 483 },
      { text: 'レベルが　あがった！', font: "'Hiragino Sans'", weight: 600, size: 36, monospace: true, tracking: 0.17, color: '#fff', x: 96, y: 546 }
    ]
  },
  {
    name: 'katakana',
    width: 1280,
    height: 420,
    background: '#f4f1ea',
    lines: [
      { text: 'エクスペリエンスポイントを1500獲得しました！', font: "'Toppan Bunkyu Gothic'", size: 40, color: '#111', x: 60, y: 60 },
      { text: 'HPが回復した。レベル12→13にアップ', font: "'Toppan Bunkyu Gothic'", size: 40, color: '#111', x: 60, y: 160 },
      { text: 'スーパーファミコン版クロノ・トリガー', font: "'Toppan Bunkyu Gothic'", size: 40, color: '#111', x: 60, y: 260 }
    ]
  },
  {
    name: 'small',
    width: 960,
    height: 400,
    background: '#1f2228',
    panels: [{ x: 30, y: 30, width: 560, height: 320, fill: '#2c3340', stroke: '#8894aa', border: 2, radius: 8 }],
    lines: [
      { text: '装備品を確認してください。', font: "'Hiragino Sans'", size: 18, color: '#eef', x: 54, y: 60 },
      { text: '攻撃力が３上がった。防御力が１下がった。', font: "'Hiragino Sans'", size: 18, color: '#eef', x: 54, y: 110 },
      { text: 'このアイテムは売却できません。', font: "'Hiragino Sans'", size: 18, color: '#eef', x: 54, y: 160 },
      { text: 'セーブデータを読み込んでいます', font: "'Hiragino Sans'", size: 18, color: '#eef', x: 54, y: 210 },
      { text: '所持金12480G　経験値3201', font: "'Hiragino Sans'", size: 18, color: '#eef', x: 54, y: 260 }
    ]
  },
  {
    name: 'large',
    width: 1280,
    height: 400,
    background: '#efe3c8',
    lines: [
      { text: '第三章　失われた記憶', font: "'Hiragino Mincho ProN'", weight: 600, size: 84, color: '#2a1a10', x: 180, y: 90 },
      { text: 'それぞれの決意', font: "'Hiragino Mincho ProN'", weight: 600, size: 44, color: '#5a3a20', x: 430, y: 250 }
    ]
  },
  {
    name: 'vertical',
    width: 900,
    height: 900,
    background: '#fbfaf6',
    lines: [
      { text: '吾輩は猫である', font: "'Hiragino Mincho ProN'", size: 42, tracking: 0.1, color: '#111', x: 760, y: 80, vertical: true },
      { text: '名前はまだ無い', font: "'Hiragino Mincho ProN'", size: 42, tracking: 0.1, color: '#111', x: 680, y: 80, vertical: true },
      { text: 'どこで生れたかとんと見当がつかぬ', font: "'Hiragino Mincho ProN'", size: 42, tracking: 0.1, color: '#111', x: 600, y: 80, vertical: true }
    ]
  }
]

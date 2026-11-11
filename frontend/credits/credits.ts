/**
 * The open-source work Kimochi stands on: one list for the app's Settings → About and the
 * website's "Free and open source" section (which imports this file as `@kimochi/credits`). A
 * reader's summary of NOTICE, which stays the full record (exact versions, hashes and licence
 * texts): keep the two in step when something is added or removed there.
 *
 * Each project has a tile: its own logo (icons/<file>, listed in icons.json) or, where it has
 * none, an emoji on a tint (credits.css). Each group names a Lucide icon; the app and the site
 * map the name to their own copy of lucide-react, so this file imports nothing from either.
 */
import ICONS from './icons.json'

/** The tile tints (credits.css `.credit-tint-*`). */
export type CreditTint =
  | 'amber'
  | 'orange'
  | 'red'
  | 'pink'
  | 'violet'
  | 'indigo'
  | 'blue'
  | 'cyan'
  | 'teal'
  | 'green'
  | 'lime'
  | 'gray'

/** A project's tile: its logo, or an emoji on a tint. */
export type CreditIcon = { logo: string; tint?: CreditTint } | { emoji: string; tint: CreditTint }

export interface Acknowledgement {
  /** Stable key, and the key in icons.json. */
  id: string
  name: string
  /** What Kimochi uses it for, in a few words. */
  role: string
  license: string
  url: string
}

/** The Lucide icons the groups use (each consumer maps these names to components). */
export type CreditGroupIcon = 'BookOpenText' | 'ScanText' | 'FishingHook' | 'AudioLines' | 'Lightbulb' | 'AppWindow' | 'Type'

export interface AcknowledgementGroup {
  title: string
  icon: CreditGroupIcon
  items: readonly Acknowledgement[]
}

export const NOTICE_URL = 'https://github.com/hamstu/kimochi/blob/main/NOTICE'

/** The logo files, bundled by whichever Vite build imports this module. */
const LOGO_URLS = import.meta.glob<string>('./icons/*.{svg,png}', { eager: true, query: '?url', import: 'default' })

const FALLBACK: { emoji: string; tint: CreditTint } = { emoji: '📦', tint: 'gray' }

/** A project's tile, with the logo resolved to a URL. */
export function creditIcon(id: string): { src: string; tint?: CreditTint } | { emoji: string; tint: CreditTint } {
  const icon = ((ICONS as Record<string, CreditIcon>)[id] ?? FALLBACK) as CreditIcon
  if ('logo' in icon) {
    const src = LOGO_URLS[`./icons/${icon.logo}`]
    return src ? { src, tint: icon.tint } : FALLBACK
  }
  return icon
}

export const ACKNOWLEDGEMENTS: readonly AcknowledgementGroup[] = [
  {
    title: 'Dictionaries',
    icon: 'BookOpenText',
    items: [
      {
        id: 'yomitan',
        name: 'Yomitan',
        role: 'The classic pop-up dictionary. You know it, you love it. We also support using the Yomitan API to read your own dictionaries from an existing setup.',
        license: 'GPL-3.0',
        url: 'https://github.com/yomidevs/yomitan'
      },
      {
        id: 'hachidori',
        name: 'Hachidori',
        role: 'The new kid on the block. It comes with some great features and super fast lookups. Bee-san cooked with this one. ✨',
        license: 'GPL-3.0',
        url: 'https://github.com/bee-san/hachidori'
      },
      {
        id: '10ten-japanese-reader',
        name: '10ten Japanese Reader',
        role: 'Simple and clean pop-up dictionary.',
        license: 'GPL-3.0',
        url: 'https://github.com/birchill/10ten-ja-reader'
      },
      {
        id: 'jitendex',
        name: 'Jitendex',
        role: 'The initial dictionary we offer for Yomitan in the app.',
        license: 'CC BY-SA 4.0',
        url: 'https://jitendex.org'
      },
      {
        id: 'jmdict-kanjidic-and-jmnedict',
        name: 'JMdict, KANJIDIC and JMnedict',
        role: 'The Electronic Dictionary Research and Development Group’s dictionary data',
        license: 'CC BY-SA',
        url: 'https://www.edrdg.org'
      }
    ]
  },
  {
    title: 'Text recognition',
    icon: 'ScanText',
    items: [
      {
        id: 'meikiocr',
        name: 'MeikiOCR',
        role: 'On-device OCR for games, ported to Rust',
        license: 'Apache-2.0 · models LGPL-3.0',
        url: 'https://github.com/rtr46/meikiocr'
      },
      {
        id: 'paddleocr-pp-ocrv6',
        name: 'PaddleOCR (PP-OCRv6)',
        role: 'On-device text detection and recognition',
        license: 'Apache-2.0 · models Apache-2.0',
        url: 'https://github.com/PaddlePaddle/PaddleOCR'
      },
      {
        id: 'vita-vn-ocr',
        name: 'VOCR6 (vita-vn-ocr)',
        role: 'On-device OCR for visual-novel dialogue, ported to Rust',
        license: 'GPL-3.0-or-later · models non-commercial use only',
        url: 'https://github.com/bee-san/vita-vn-ocr'
      },
      {
        id: 'manga-ocr',
        name: 'Manga OCR',
        role: 'On-device OCR for manga',
        license: 'Apache-2.0',
        url: 'https://github.com/kha-white/manga-ocr'
      },
      {
        id: 'comic-text-detector',
        name: 'Comic Text Detector',
        role: 'Finds the speech bubbles Manga OCR reads',
        license: 'GPL-3.0',
        url: 'https://github.com/dmMaze/comic-text-detector'
      },
      {
        id: 'owocr',
        name: 'owocr',
        role: 'Our Google Lens engine is ported from it',
        license: 'GPL-3.0',
        url: 'https://github.com/AuroraWright/owocr'
      },
      {
        id: 'onnx-runtime',
        name: 'ONNX Runtime',
        role: 'Runs the on-device OCR models',
        license: 'MIT',
        url: 'https://github.com/microsoft/onnxruntime'
      }
    ]
  },
  {
    title: 'Text hooking',
    icon: 'FishingHook',
    items: [
      {
        id: 'lunahook',
        name: 'LunaHook',
        role: 'The Text Hooker, from LunaTranslator.',
        license: 'GPL-3.0',
        url: 'https://github.com/HIllya51/LunaTranslator'
      },
      {
        id: 'textractor',
        name: 'Textractor',
        role: 'The Text Hooker’s fallback',
        license: 'GPL-3.0',
        url: 'https://github.com/Artikash/Textractor'
      }
    ]
  },
  {
    title: 'Sentence audio',
    icon: 'AudioLines',
    items: [
      {
        id: 'sensevoice',
        name: 'SenseVoice',
        role: 'Hears what is said, to match each line to its voice (FunASR, Alibaba)',
        license: 'FunASR Model License',
        url: 'https://github.com/FunAudioLLM/SenseVoice'
      },
      {
        id: 'sherpa-onnx',
        name: 'sherpa-onnx',
        role: 'SenseVoice in ONNX, and how to run it',
        license: 'Apache-2.0',
        url: 'https://github.com/k2-fsa/sherpa-onnx'
      },
      {
        id: 'unihan',
        name: 'Unihan',
        role: 'Kanji readings, so a line’s kanji line up with the kana heard (Unicode)',
        license: 'Unicode-3.0',
        url: 'https://www.unicode.org/charts/unihan.html'
      },
      {
        id: 'silero-vad',
        name: 'Silero VAD',
        role: 'Hears where speech is',
        license: 'MIT',
        url: 'https://github.com/snakers4/silero-vad'
      },
      {
        id: 'lame',
        name: 'LAME',
        role: 'Encodes the clips as MP3',
        license: 'LGPL-2.0',
        url: 'https://lame.sourceforge.io'
      }
    ]
  },
  {
    title: 'Ideas',
    icon: 'Lightbulb',
    items: [
      {
        id: 'gamesentenceminer',
        name: 'GameSentenceMiner',
        role: 'An incredibly full-featured app for all things Japanese learning/mining/OCR and more.',
        license: 'GPL-3.0',
        url: 'https://github.com/bpwhelan/GameSentenceMiner'
      },
      {
        id: 'meikipop',
        name: 'meikipop',
        role: 'Pop-up reading on top of OCR',
        license: 'GPL-3.0',
        url: 'https://github.com/rtr46/meikipop'
      }
    ]
  },
  {
    title: 'The app',
    icon: 'AppWindow',
    items: [
      {
        id: 'tauri',
        name: 'Tauri',
        role: "The app's foundation: windows, menus, tray and updates",
        license: 'MIT / Apache-2.0',
        url: 'https://tauri.app'
      },
      {
        id: 'rust',
        name: 'Rust',
        role: 'The engine. Handles capture, OCR and everything native.',
        license: 'MIT / Apache-2.0',
        url: 'https://www.rust-lang.org'
      },
      {
        id: 'react',
        name: 'React',
        role: "The main app's interface.",
        license: 'MIT',
        url: 'https://react.dev'
      },
      {
        id: 'radix-ui',
        name: 'Radix UI',
        role: 'Accessible menus, dialogs and controls',
        license: 'MIT',
        url: 'https://www.radix-ui.com'
      },
      {
        id: 'lucide',
        name: 'Lucide',
        role: 'Icons',
        license: 'ISC',
        url: 'https://lucide.dev'
      },
      {
        id: 'wanakana',
        name: 'WanaKana',
        role: 'Kana and romaji conversion',
        license: 'MIT',
        url: 'https://github.com/WaniKani/WanaKana'
      },
      {
        id: 'marked-and-dompurify',
        name: 'Marked and DOMPurify',
        role: 'Release notes and safe HTML',
        license: 'MIT · Apache-2.0',
        url: 'https://github.com/markedjs/marked'
      }
    ]
  },
  {
    title: 'Type and sound',
    icon: 'Type',
    items: [
      {
        id: 'figtree',
        name: 'Figtree',
        role: 'Interface typeface',
        license: 'OFL-1.1',
        url: 'https://github.com/erikdkennedy/figtree'
      },
      {
        id: 'noto-sans-jp',
        name: 'Noto Sans JP',
        role: 'Japanese typeface',
        license: 'OFL-1.1',
        url: 'https://fonts.google.com/noto/specimen/Noto+Sans+JP'
      },
      {
        id: 'zen-kaku-gothic-antique',
        name: 'Zen Kaku Gothic Antique',
        role: 'Manga OCR text in the overlay',
        license: 'OFL-1.1',
        url: 'https://github.com/googlefonts/zen-kakugothic'
      },
      {
        id: 'kenney',
        name: 'Kenney',
        role: 'Scan sounds',
        license: 'CC0',
        url: 'https://www.kenney.nl'
      },
      {
        id: 'earshot',
        name: 'Earshot',
        role: 'Interface sounds',
        license: 'MIT',
        url: 'https://github.com/Leonxlnx/earshot'
      }
    ]
  }
]

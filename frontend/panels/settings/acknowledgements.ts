/**
 * The open-source work Kimochi stands on, for Settings → About. A reader's summary of NOTICE,
 * which stays the full record (exact versions, hashes and licence texts): keep the two in step
 * when something is added or removed there.
 */

export interface Acknowledgement {
  name: string
  /** What Kimochi uses it for, in a few words. */
  role: string
  license: string
  url: string
}

export interface AcknowledgementGroup {
  title: string
  items: readonly Acknowledgement[]
}

export const ACKNOWLEDGEMENTS: readonly AcknowledgementGroup[] = [
  {
    title: 'Dictionaries',
    items: [
      {
        name: 'Yomitan',
        role: 'Pop-up dictionary, run unmodified from its own release',
        license: 'GPL-3.0',
        url: 'https://github.com/yomidevs/yomitan'
      },
      {
        name: 'Hachidori',
        role: 'Pop-up dictionary, run unmodified from its own release',
        license: 'GPL-3.0',
        url: 'https://github.com/bee-san/hachidori'
      },
      {
        name: '10ten Japanese Reader',
        role: 'Pop-up dictionary, run unmodified from its own release',
        license: 'GPL-3.0',
        url: 'https://github.com/birchill/10ten-ja-reader'
      },
      {
        name: 'Jitendex',
        role: 'The dictionary the setup offers for Yomitan',
        license: 'CC BY-SA 4.0',
        url: 'https://jitendex.org'
      },
      {
        name: 'JMdict, KANJIDIC and JMnedict',
        role: 'The Electronic Dictionary Research and Development Group’s dictionary data',
        license: 'CC BY-SA',
        url: 'https://www.edrdg.org'
      }
    ]
  },
  {
    title: 'Text recognition',
    items: [
      {
        name: 'MeikiOCR',
        role: 'On-device OCR for games, ported to Rust',
        license: 'Apache-2.0 · models LGPL-3.0',
        url: 'https://github.com/rtr46/meikiocr'
      },
      {
        name: 'Manga OCR',
        role: 'On-device OCR for manga',
        license: 'Apache-2.0',
        url: 'https://github.com/kha-white/manga-ocr'
      },
      {
        name: 'Comic Text Detector',
        role: 'Finds the speech bubbles Manga OCR reads',
        license: 'GPL-3.0',
        url: 'https://github.com/dmMaze/comic-text-detector'
      },
      {
        name: 'owocr',
        role: 'The Google Lens engine is ported from it',
        license: 'GPL-3.0',
        url: 'https://github.com/AuroraWright/owocr'
      },
      {
        name: 'ONNX Runtime',
        role: 'Runs the on-device OCR models',
        license: 'MIT',
        url: 'https://github.com/microsoft/onnxruntime'
      }
    ]
  },
  {
    title: 'Sentence audio',
    items: [
      {
        name: 'SenseVoice',
        role: 'Hears what is said, to match each line to its voice (FunASR, Alibaba)',
        license: 'FunASR Model License',
        url: 'https://github.com/FunAudioLLM/SenseVoice'
      },
      {
        name: 'sherpa-onnx',
        role: 'SenseVoice in ONNX, and how to run it',
        license: 'Apache-2.0',
        url: 'https://github.com/k2-fsa/sherpa-onnx'
      },
      {
        name: 'Unihan',
        role: 'Kanji readings, so a line’s kanji line up with the kana heard (Unicode)',
        license: 'Unicode-3.0',
        url: 'https://www.unicode.org/charts/unihan.html'
      },
      {
        name: 'Silero VAD',
        role: 'Hears where speech is',
        license: 'MIT',
        url: 'https://github.com/snakers4/silero-vad'
      },
      {
        name: 'LAME',
        role: 'Encodes the clips as MP3',
        license: 'LGPL-2.0',
        url: 'https://lame.sourceforge.io'
      }
    ]
  },
  {
    title: 'Ideas',
    items: [
      {
        name: 'GameSentenceMiner',
        role: 'Automatic OCR, reading games with a controller, and sentence audio',
        license: 'GPL-3.0',
        url: 'https://github.com/bpwhelan/GameSentenceMiner'
      },
      {
        name: 'meikipop',
        role: 'Pop-up reading on top of OCR',
        license: 'GPL-3.0',
        url: 'https://github.com/rtr46/meikipop'
      }
    ]
  },
  {
    title: 'The app',
    items: [
      {
        name: 'Tauri',
        role: 'The native shell: windows, menus, tray and updates',
        license: 'MIT / Apache-2.0',
        url: 'https://tauri.app'
      },
      {
        name: 'Rust',
        role: 'Capture, OCR and everything native, with many crates from crates.io',
        license: 'MIT / Apache-2.0',
        url: 'https://www.rust-lang.org'
      },
      {
        name: 'React',
        role: 'Every window’s interface',
        license: 'MIT',
        url: 'https://react.dev'
      },
      {
        name: 'Radix UI',
        role: 'Accessible menus, dialogs and controls',
        license: 'MIT',
        url: 'https://www.radix-ui.com'
      },
      {
        name: 'Lucide',
        role: 'Icons',
        license: 'ISC',
        url: 'https://lucide.dev'
      },
      {
        name: 'WanaKana',
        role: 'Kana and romaji conversion',
        license: 'MIT',
        url: 'https://github.com/WaniKani/WanaKana'
      },
      {
        name: 'Marked and DOMPurify',
        role: 'Release notes and safe HTML',
        license: 'MIT · Apache-2.0',
        url: 'https://github.com/markedjs/marked'
      }
    ]
  },
  {
    title: 'Type and sound',
    items: [
      {
        name: 'Figtree',
        role: 'Interface typeface',
        license: 'OFL-1.1',
        url: 'https://github.com/erikdkennedy/figtree'
      },
      {
        name: 'Noto Sans JP',
        role: 'Japanese typeface',
        license: 'OFL-1.1',
        url: 'https://fonts.google.com/noto/specimen/Noto+Sans+JP'
      },
      {
        name: 'Zen Kaku Gothic Antique',
        role: 'Manga OCR text in the overlay',
        license: 'OFL-1.1',
        url: 'https://github.com/googlefonts/zen-kakugothic'
      },
      {
        name: 'Kenney',
        role: 'Scan sounds',
        license: 'CC0',
        url: 'https://www.kenney.nl'
      },
      {
        name: 'Earshot',
        role: 'Interface sounds',
        license: 'MIT',
        url: 'https://github.com/Leonxlnx/earshot'
      }
    ]
  }
]

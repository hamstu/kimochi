/**
 * The FAQ: /faq shows every question, the home page the first HOME_FAQ_COUNT, and /faq's FAQPage
 * JSON-LD is built from the same text (src/lib/seo.js). Every answer uses only facts already on
 * the site, and opens with the direct answer so it can be quoted on its own.
 *
 * `a` is the answer's paragraphs (plain text: it also goes into JSON-LD). `links` are shown after
 * it. `todo` is what Hamish still has to supply or confirm: shown on the page in the dev server
 * only, marked TODO(hamish).
 *
 * @typedef {{ href: string, label: string }} FaqLink
 * @typedef {{ id: string, q: string, a: string[], links?: FaqLink[], todo?: string }} FaqItem
 */

import { docsUrl } from '../lib/docs.js'

/** How many questions the home page shows. */
export const HOME_FAQ_COUNT = 7

/** @type {FaqItem[]} */
export const FAQ = [
  {
    id: 'what-is-kimochi',
    q: 'What is Kimochi?',
    a: [
      'Kimochi is a free, open-source desktop app that helps you read Japanese in games. It captures the Japanese text on your screen with OCR, can draw that text back over the game as an overlay, and lets you hover any word to look it up in your favourite dictionary and save it to Anki. It works on games, visual novels, manga, YouTube videos and anything else on your screen.'
    ]
  },
  {
    id: 'who-is-it-for',
    q: 'Who is Kimochi for?',
    a: [
      'Kimochi is for anyone learning Japanese by reading the games, visual novels and manga they enjoy, from total beginners to advanced readers. Every word is a hover away from its reading and meaning, so you can start on real Japanese from day one. It started as the tool its maker, Hamish Macpherson, wanted: something that reads the game for you, gets out of the way, and lets you look up the word you’re stuck on without breaking the flow.'
    ]
  },
  {
    id: 'how-does-it-work',
    q: 'How does Kimochi work?',
    a: [
      'There are four steps. Pick the game window or screen, and crop it if you like. Press Scan, or turn on Auto OCR. The text shows up in Kimochi’s Log, and over the game if the overlay is on. Then hover a word to look it up, hear it, or save it. Every line is kept in a Log you can scroll back through, with a separate session for each game.'
    ],
    links: [{ href: docsUrl('/quick-start/'), label: 'Quick start in the docs' }]
  },
  {
    id: 'price',
    q: 'Is Kimochi free? What does Kimochi Cloud cost?',
    a: [
      'Yes, Kimochi is free forever, with no account and no limits on the core app: the overlay, Auto OCR, on-device and online OCR engines, the Log, Sessions, the Notebook, dictionaries, one-click Anki cards and Gaming Mode.',
      'Kimochi Cloud is optional and costs US$6 a month, US$60 a year (two months free, so $5 a month), or US$125 once for lifetime. It adds in-app translation, AI explanations, ElevenLabs read-aloud, Google Vision cloud OCR and sync across devices, with a 14-day free trial. A free account on its own doesn’t include any of these.'
    ],
    links: [{ href: '/#open-source', label: 'Plans on the home page' }]
  },
  {
    id: 'platforms',
    q: 'Which platforms does Kimochi run on?',
    a: [
      'Kimochi runs on macOS 14 or later on Apple silicon (an Intel Mac build is planned), Windows 10 22H2 or later (x64 and ARM64) and Linux (x64 and ARM64), and has a Gaming Mode for the Steam Deck. macOS support is the most mature, and Steam Deck Gaming Mode is in early testing. On Linux, the overlay is tested on Hyprland (Omarchy) and on GNOME 46.'
    ],
    links: [
      { href: '/download/linux', label: 'Installing on Linux and Steam Deck' },
      { href: docsUrl('/install/'), label: 'Installation guide' }
    ]
  },
  {
    id: 'privacy',
    q: 'Does Kimochi send my screen to the cloud? Is it private?',
    a: [
      'Only if you choose an online OCR engine. Kimochi has no analytics, telemetry, crash reporting or ads. Your captures, log, notebook, statistics and settings stay on your computer, unless you turn on Sync with Kimochi Cloud, which keeps them in step between your computers.',
      'Google Lens (the default engine) and Kimochi Cloud OCR send the captured region for recognition. If you’d rather nothing leave your machine, pick an on-device engine: Apple Live Text (macOS), MeikiOCR, Manga OCR or OneOCR (Windows). The privacy policy lists exactly what each feature sends and when.'
    ],
    links: [{ href: '/privacy', label: 'Privacy policy' }]
  },
  {
    id: 'account',
    q: 'Do I need an account?',
    a: [
      'No. Kimochi works fully without an account. You only need one for Kimochi Cloud: cloud OCR, read aloud, translation, AI explanations and sync. You can sign up with email, Google or Discord, and you can download or delete everything from your account page at any time.'
    ],
    links: [{ href: docsUrl('/cloud/'), label: 'Accounts and plans' }]
  },
  {
    id: 'engines-and-dictionaries',
    q: 'Which OCR engines and dictionaries does Kimochi support?',
    a: [
      'OCR engines: Google Lens (the default, online), Apple Live Text (macOS, built in), MeikiOCR (on device, on the GPU), Manga OCR (on device, tuned for manga), or OneOCR (Windows 11, built in).',
      'Dictionaries: a built-in copy of Yomitan with your own dictionaries, Hachidori, 10ten, or the Yomitan in your browser through the Yomitan API.'
    ],
    links: [
      { href: docsUrl('/reading/ocr-engines/'), label: 'OCR engines' },
      { href: docsUrl('/lookups/dictionaries/'), label: 'Dictionaries' }
    ]
  },
  {
    id: 'anki-and-texthookers',
    q: 'Does Kimochi work with Anki and texthookers?',
    a: [
      'Yes. Kimochi adds cards to Anki through the AnkiConnect add-on. If you already hook text out of a visual novel, point Kimochi at your texthooker over WebSocket, or just copy lines to the clipboard. They land in the same Log, with the same lookups, Notebook and stats. Any texthooker that sends text over WebSocket works, and Kimochi can also take owocr’s output.'
    ],
    links: [
      { href: docsUrl('/lookups/anki/'), label: 'Anki' },
      { href: docsUrl('/reading/texthookers/'), label: 'Texthookers' }
    ]
  },
  {
    id: 'obs-and-extensions',
    q: 'Do I need OBS or a browser extension?',
    a: [
      'No. Kimochi has built-in screen and window capture with a crop region, so OBS isn’t needed, and Yomitan is built in, so no browser tabs are required. You can still use the Yomitan in your browser through the Yomitan API if you prefer.'
    ]
  },
  {
    id: 'alternatives',
    q: 'How is Kimochi different from Game Sentence Miner, Kamui, owocr or YomiNinja?',
    a: [
      'Kimochi puts capture, OCR, the overlay, a log, Yomitan, Anki and a notebook in one app, with no OBS and no browser tabs, and a controller works too. Game Sentence Miner is better if you want rich Anki sentence cards with audio and screenshots (it needs OBS). owocr is great if you like building your own setup. Kamui is a paid, closed-source web and Windows app if you want everything handled for you in the cloud. YomiNinja is a free, open-source overlay with Yomitan and 10ten built in; Anki integration is on its planned list.'
    ],
    links: [{ href: '/compare', label: 'The full, sourced comparison' }]
  },
  {
    id: 'controller',
    q: 'Can I use Kimochi with a controller or on the Steam Deck?',
    a: [
      'Yes, though Steam Deck support is early. In Gaming Mode, click both sticks (L3 + R3) to scan, pick a word with the D-pad, press A for the reading, and press B to go back to the game.'
    ],
    links: [{ href: docsUrl('/controller/'), label: 'Controller and Gaming Mode' }]
  },
  {
    id: 'open-source',
    q: 'Is Kimochi open source? Where is the code?',
    a: ['Yes. Kimochi is free and open source under the GPL-3.0 licence, and its source is on GitHub.'],
    links: [{ href: 'https://github.com/hamstu/kimochi-tauri', label: 'Kimochi on GitHub' }]
  },
  {
    id: 'mobile-and-languages',
    q: 'Does Kimochi work on phones or tablets, or for languages other than Japanese?',
    a: [
      'Not yet. Kimochi is a desktop app for macOS, Windows and Linux, plus Gaming Mode on the Steam Deck, and it is made for reading Japanese. Phones, tablets and other languages may come later.'
    ]
  },
  {
    id: 'feedback',
    q: 'How do I report a bug or give feedback?',
    a: ['Open an issue on Kimochi’s GitHub repository: bug reports, ideas and questions are all welcome there.'],
    links: [
      { href: 'https://github.com/hamstu/kimochi-tauri/issues', label: 'Kimochi’s GitHub issues' },
      { href: docsUrl('/help/troubleshooting/'), label: 'Troubleshooting' }
    ]
  }
]

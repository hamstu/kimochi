/**
 * The questions on /linux-steam-deck-text-hooker, rendered on the page and as its FAQPage JSON-LD
 * (src/lib/seo.js). Same shape as faq.js. Every answer must match
 * https://docs.kimochiapp.com/reading/text-hooker/.
 *
 * @typedef {import('./faq.js').FaqItem} FaqItem
 */
import { docsUrl } from '../lib/docs.js'

/** @type {FaqItem[]} */
export const LINUX_HOOKER_FAQ = [
  {
    id: 'textractor-on-linux',
    q: 'Can I use Textractor on Linux?',
    a: [
      'Yes, inside the game’s Wine or Proton prefix. Kimochi does that for you with LunaHook (the hooker from LunaTranslator), and falls back to Textractor if LunaHook can’t hook the game.'
    ]
  },
  {
    id: 'gaming-mode',
    q: 'Does text hooking work in Steam Deck Gaming Mode?',
    a: ['Yes. Choose the game in Kimochi’s Source tab.'],
    links: [{ href: docsUrl('/controller/gaming-mode/'), label: 'Gaming Mode in the docs' }]
  },
  {
    id: 'lutris-heroic-bottles',
    q: 'Does it work with Lutris, Heroic or Bottles?',
    a: ['Yes, for Windows games run through Wine.']
  },
  {
    id: 'free',
    q: 'Is it free?',
    a: ['Yes. Kimochi is free and open source (GPL-3.0), and needs no account.']
  },
  {
    id: 'hooking-or-ocr',
    q: 'Hooking or OCR: which should I use?',
    a: [
      'Hook the game when it can be hooked: you get the exact text the game wrote, with no OCR misreads. Use OCR for everything else.'
    ],
    links: [{ href: docsUrl('/reading/sources/'), label: 'Reading with OCR' }]
  }
]

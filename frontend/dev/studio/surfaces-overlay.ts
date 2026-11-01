/**
 * DEV-ONLY: the overlay stage's surfaces for the UI studio (frontend/dev/stage.html): the overlay
 * over a game's text, and Gaming Mode's controller UI. Each scene is a context, so the studio lists
 * them as tabs; its parameters are documented in frontend/dev/stage/stage.ts.
 */
import { DEFAULT_HISTORY, DEFAULT_SCRIPT } from '../stage/script'
import type { Control, ControlGroup, StudioContext, Surface } from './types'

const scene = (frame: Window): StudioContext => {
  const value = new URLSearchParams(frame.location.search).get('scene')
  return value ? { scene: value } : {}
}
const inScene =
  (...scenes: string[]) =>
  (context: StudioContext): boolean =>
    scenes.includes(context.scene ?? '')

const THEME: Control = {
  kind: 'select',
  param: 'theme',
  label: 'Pop-up appearance',
  options: [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' }
  ],
  default: 'system',
  help: 'The dictionary pop-up’s and the region editor’s; the controller UI is always dark.'
}

const GAME: ControlGroup = {
  title: 'Game',
  controls: [
    {
      kind: 'select',
      param: 'game',
      label: 'Game',
      options: [
        { value: 'dialogue', label: 'Visual novel (dialogue box)' },
        { value: 'manga', label: 'Manga (vertical bubbles)' }
      ],
      default: 'dialogue'
    },
    { kind: 'toggle', param: 'windowed', label: 'Windowed (a Mac game)', on: '1', help: 'Off: the whole screen, as on the Deck.' },
    { kind: 'toggle', param: 'furigana', label: 'Furigana', on: '1', off: '0', default: true }
  ]
}

const TEXT: ControlGroup = {
  title: 'Overlay text',
  controls: [
    { kind: 'toggle', param: 'grouping', label: 'Group text into regions', on: '1' },
    { kind: 'text', param: 'strength', label: 'Highlight opacity (0–100)', placeholder: '40' },
    {
      kind: 'toggle',
      param: 'filter',
      label: 'Filter out furigana and small text',
      on: '1',
      off: '0',
      default: true
    },
    {
      kind: 'select',
      param: 'typeface',
      label: 'Typeface',
      options: [
        { value: 'default', label: 'Default' },
        { value: 'manga', label: 'Manga OCR’s (Zen Kaku Gothic)' }
      ],
      default: 'default'
    },
    {
      kind: 'text',
      param: 'highlight',
      label: 'Highlight colour (rrggbb)',
      placeholder: '3e63dd',
      help: 'Settings → OCR & Overlay → Overlay look: the tint and outline over hoverable text.'
    },
    {
      kind: 'select',
      param: 'cards',
      label: 'Cards',
      options: [
        { value: 'theme', label: 'Same as the pop-up' },
        { value: 'light', label: 'Light' },
        { value: 'dark', label: 'Dark' }
      ],
      default: 'theme',
      help: 'The card a hovered word turns into, and the grouped regions.'
    }
  ]
}

const DICTIONARY: Control = {
  kind: 'select',
  param: 'popup',
  label: 'Dictionary',
  options: [
    { value: 'yomitan', label: 'Yomitan' },
    { value: 'hachidori', label: 'Hachidori' },
    { value: 'tenten', label: '10ten' },
    { value: 'custom-api', label: 'Yomitan API' }
  ],
  default: 'yomitan',
  help: 'Yomitan’s and Hachidori’s pop-ups have buttons A can move into.'
}

const JSON_STATE = [
  {
    key: 'script',
    label: 'Game text and dictionary',
    help: 'lines (the dialogue box), bubbles (manga columns, right to left) and words (what a lookup shows). Furigana inline: 今日《きょう》.',
    initial: DEFAULT_SCRIPT
  },
  {
    key: 'history',
    label: 'Recent text',
    help: 'The entries the controller’s Recent text lists.',
    initial: DEFAULT_HISTORY,
    when: inScene('controller-history')
  }
] as const

export const OVERLAY_SURFACES: Surface[] = [
  {
    id: 'overlay',
    group: 'Overlay',
    label: 'Overlay',
    page: 'stage.html',
    size: { width: 1280, height: 800, minWidth: 640, minHeight: 400 },
    frameless: true,
    contexts: {
      param: 'scene',
      label: 'Scene',
      options: [
        { value: 'overlay-words', label: 'Text over the game' },
        { value: 'overlay-hover', label: 'Source outline' },
        { value: 'region-select', label: 'Region editor' }
      ]
    },
    locate: scene,
    groups: [
      GAME,
      { ...TEXT, when: inScene('overlay-words', '') },
      {
        title: 'Pointer and pop-up',
        when: inScene('overlay-words', ''),
        controls: [
          { kind: 'text', param: 'hover', label: 'Rest the pointer at (x,y)', placeholder: '200,656', help: 'Or move the mouse over the text; hold Shift over a word to look it up.' },
          { kind: 'toggle', param: 'lookup', label: 'Pop-up open on the first line', on: '1' },
          THEME
        ]
      },
      {
        title: 'Source outline',
        when: inScene('overlay-hover'),
        controls: [{ kind: 'toggle', param: 'crop', label: 'Saved crop too', on: '1', help: 'Hovering Select Region in the main window.' }]
      },
      {
        title: 'Region editor',
        when: inScene('region-select'),
        controls: [
          { kind: 'toggle', param: 'initial', label: 'Open with a box drawn', on: '1' },
          { kind: 'toggle', param: 'picture', label: 'Dim, with the window’s picture', on: '1' },
          { kind: 'text', param: 'label', label: 'Confirm button', placeholder: 'Save' },
          { kind: 'text', param: 'alternate', label: 'Second button', placeholder: 'Save region' },
          {
            kind: 'select',
            param: 'accent',
            label: 'Colour',
            options: [
              { value: 'blue', label: 'Blue (OCR crop area)' },
              { value: 'green', label: 'Green (Anki crop area)' }
            ],
            default: 'blue'
          },
          { kind: 'text', param: 'title', label: 'Title in the foot', placeholder: 'Anki crop area', help: 'Hidden when the foot has no room for it.' },
          THEME
        ]
      }
    ],
    json: JSON_STATE
  },
  {
    id: 'gaming-mode',
    group: 'Gaming Mode',
    label: 'Controller',
    page: 'stage.html',
    params: { scene: 'controller-menu' },
    size: { width: 1280, height: 800, minWidth: 640, minHeight: 400 },
    frameless: true,
    contexts: {
      param: 'scene',
      label: 'Scene',
      options: [
        { value: 'controller-menu', label: 'Radial menu' },
        { value: 'controller-words', label: 'Read along' },
        { value: 'controller-controls', label: 'Controls sheet' },
        { value: 'controller-history', label: 'Recent text' }
      ]
    },
    locate: scene,
    groups: [
      {
        title: 'Controller',
        controls: [
          {
            kind: 'select',
            param: 'input',
            label: 'Opened with',
            options: [
              { value: 'pad', label: 'A controller' },
              { value: 'keys', label: 'The keyboard' }
            ],
            default: 'pad',
            help: 'The hints name buttons or keys.'
          },
          DICTIONARY,
          THEME
        ]
      },
      {
        title: 'Menu',
        when: inScene('controller-menu'),
        controls: [
          { kind: 'toggle', param: 'auto', label: 'Auto OCR on', on: '1', help: 'The menu starts on Read along.' },
          { kind: 'toggle', param: 'notext', label: 'Nothing scanned yet', on: '1' },
          { kind: 'toggle', param: 'quickshot', label: 'Quick Shot', on: '1', help: 'Auto OCR is unavailable.' }
        ]
      },
      {
        title: 'Reading',
        when: inScene('controller-words', 'controller-controls'),
        controls: [
          { kind: 'text', param: 'step', label: 'Steps along the text', placeholder: '0' },
          { kind: 'toggle', param: 'unit', label: 'By character', on: 'character' },
          { kind: 'toggle', param: 'cursor', label: 'Free cursor out', on: 'free' },
          { kind: 'toggle', param: 'layer', label: 'In the pop-up’s buttons', on: 'popup' },
          { kind: 'toggle', param: 'driver', label: 'The mouse took over', on: 'mouse' }
        ]
      },
      {
        title: 'Recent text',
        when: inScene('controller-history'),
        controls: [{ kind: 'toggle', param: 'read', label: 'Reading the chosen entry', on: '1' }]
      },
      GAME,
      { ...TEXT, when: inScene('controller-words', 'controller-controls') }
    ],
    json: JSON_STATE
  }
]

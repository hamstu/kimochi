/**
 * The settings categories: Account first (every other page's settings are the account's), then the
 * order text moves through Kimochi; and older stored names.
 */
import {
  BookOpen,
  Gamepad2,
  Globe,
  Info,
  Layers,
  Languages,
  Plug,
  Puzzle,
  ScanText,
  ScrollText,
  SlidersHorizontal,
  SquareTerminal,
  SquaresIntersect,
  UserRound,
  Waypoints
} from 'lucide-react'
import type { SettingsTabName } from '../../bridge/tauri'
import type { SettingsNavItem } from './SettingsShell'

export const SETTINGS_NAV: readonly (SettingsNavItem & { value: SettingsTabName })[] = [
  { value: 'account', label: 'Account', icon: <UserRound /> },
  { value: 'general', label: 'General', icon: <SlidersHorizontal /> },
  { value: 'language', label: 'Language', icon: <Globe /> },
  { value: 'sources', label: 'Sources', icon: <Waypoints /> },
  { value: 'texthooker', label: 'Text Hooker', icon: <Plug /> },
  { value: 'ocr', label: 'OCR', icon: <ScanText /> },
  { value: 'overlay', label: 'Overlay', icon: <SquaresIntersect /> },
  { value: 'log', label: 'Log & Sessions', icon: <ScrollText /> },
  { value: 'dictionary', label: 'Dictionary', icon: <BookOpen /> },
  { value: 'anki', label: 'Anki', icon: <Layers /> },
  { value: 'assist', label: 'Translation & AI', icon: <Languages /> },
  { value: 'controls', label: 'Shortcuts & Controls', icon: <Gamepad2 /> },
  { value: 'cli', label: 'Command line', icon: <SquareTerminal /> },
  { value: 'browser', label: 'Browser Extension', icon: <Puzzle /> },
  { value: 'about', label: 'About', icon: <Info /> }
]

/** The pages this computer has: Text Hooker only where Windows games can be hooked (Windows,
 * and Linux through Proton or Wine). */
export function settingsNavFor(os: string | undefined): typeof SETTINGS_NAV {
  return os === 'windows' || os === 'linux' ? SETTINGS_NAV : SETTINGS_NAV.filter((item) => item.value !== 'texthooker')
}

/** Page names stored by earlier builds, mapped onto the pages that now hold their settings. */
const LEGACY_TABS: Record<string, SettingsTabName> = {
  mode: 'ocr',
  yomitan: 'dictionary',
  audio: 'log',
  shortcuts: 'controls',
  gamepad: 'controls',
  // Game Mode became a section of Overlay.
  gamemode: 'overlay'
}

export function settingsTabOf(stored: string): SettingsTabName {
  if (SETTINGS_NAV.some((item) => item.value === stored)) return stored as SettingsTabName
  return LEGACY_TABS[stored] ?? 'general'
}

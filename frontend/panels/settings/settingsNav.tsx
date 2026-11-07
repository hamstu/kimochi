/** The settings categories, in the order text moves through Kimochi, and older stored names. */
import {
  BookOpen,
  Gamepad2,
  Joystick,
  Info,
  Layers,
  Languages,
  Plug,
  Puzzle,
  ScanText,
  ScrollText,
  SlidersHorizontal,
  SquareTerminal,
  UserRound,
  Waypoints
} from 'lucide-react'
import type { SettingsTabName } from '../../bridge/tauri'
import type { SettingsNavItem } from './SettingsShell'

export const SETTINGS_NAV: readonly (SettingsNavItem & { value: SettingsTabName })[] = [
  { value: 'general', label: 'General', icon: <SlidersHorizontal /> },
  { value: 'sources', label: 'Sources', icon: <Waypoints /> },
  { value: 'browser', label: 'Browser Extension', icon: <Puzzle /> },
  { value: 'texthooker', label: 'Text Hooker', icon: <Plug /> },
  { value: 'ocr', label: 'OCR & Overlay', icon: <ScanText /> },
  { value: 'log', label: 'Log & Sessions', icon: <ScrollText /> },
  { value: 'dictionary', label: 'Dictionary', icon: <BookOpen /> },
  { value: 'anki', label: 'Anki', icon: <Layers /> },
  { value: 'assist', label: 'Translation & AI', icon: <Languages /> },
  { value: 'controls', label: 'Shortcuts & Controls', icon: <Gamepad2 /> },
  { value: 'gamemode', label: 'Game Mode', icon: <Joystick /> },
  { value: 'account', label: 'Account', icon: <UserRound /> },
  { value: 'cli', label: 'Command line', icon: <SquareTerminal /> },
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
  gamepad: 'controls'
}

export function settingsTabOf(stored: string): SettingsTabName {
  if (SETTINGS_NAV.some((item) => item.value === stored)) return stored as SettingsTabName
  return LEGACY_TABS[stored] ?? 'general'
}

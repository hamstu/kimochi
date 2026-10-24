/** The settings categories, in the order text moves through Kimochi, and older stored names. */
import {
  BookOpen,
  Gamepad2,
  Joystick,
  Info,
  Layers,
  Languages,
  ScanText,
  ScrollText,
  SlidersHorizontal,
  UserRound,
  Waypoints
} from 'lucide-react'
import type { SettingsTabName } from '../../bridge/tauri'
import type { SettingsNavItem } from './SettingsShell'

export const SETTINGS_NAV: readonly (SettingsNavItem & { value: SettingsTabName })[] = [
  { value: 'general', label: 'General', icon: <SlidersHorizontal /> },
  { value: 'sources', label: 'Sources', icon: <Waypoints /> },
  { value: 'ocr', label: 'OCR & Overlay', icon: <ScanText /> },
  { value: 'log', label: 'Log', icon: <ScrollText /> },
  { value: 'dictionary', label: 'Dictionary', icon: <BookOpen /> },
  { value: 'anki', label: 'Anki', icon: <Layers /> },
  { value: 'assist', label: 'Translation & AI', icon: <Languages /> },
  { value: 'controls', label: 'Shortcuts & Controls', icon: <Gamepad2 /> },
  { value: 'gamemode', label: 'Game mode', icon: <Joystick /> },
  { value: 'account', label: 'Account', icon: <UserRound /> },
  { value: 'about', label: 'About', icon: <Info /> }
]

/** Page names stored by earlier builds, mapped onto the pages that now hold their settings. */
const LEGACY_TABS: Record<string, SettingsTabName> = {
  mode: 'ocr',
  yomitan: 'dictionary',
  texthooker: 'log',
  audio: 'log',
  shortcuts: 'controls',
  gamepad: 'controls'
}

export function settingsTabOf(stored: string): SettingsTabName {
  if (SETTINGS_NAV.some((item) => item.value === stored)) return stored as SettingsTabName
  return LEGACY_TABS[stored] ?? 'general'
}

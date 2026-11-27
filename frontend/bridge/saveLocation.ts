/**
 * Where a save dialog starts (`save_default_path`, src-tauri/src/save_location.rs; COMMANDS.md →
 * Save dialogs).
 */
import { invoke } from '@tauri-apps/api/core'

/**
 * The `defaultPath` for a save dialog that suggests the file name `name`: that name in the
 * user's Downloads (or the next of their folders that can be written). A bare name would open
 * the dialog in the app's working directory, which for an AppImage is its read-only mount.
 */
export const defaultSavePath = (name: string): Promise<string> =>
  invoke<string>('save_default_path', { name }).catch(() => name)

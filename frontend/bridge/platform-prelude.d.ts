/** What native's platform prelude sets before any page runs (`platform_prelude` in `src-tauri/src/platform`). */
interface Window {
  __KIMOCHI_PLATFORM__?: { os: string }
}

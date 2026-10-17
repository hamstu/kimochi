/**
 * Whether this is a local development build. `import.meta.env.DEV` covers the Vite dev servers
 * (`tauri dev` and `npm run preview:ui`); a debug native build loading a `vite build` (`npm run
 * bundle`) says so through `__KIMOCHI_PLATFORM__.debug` (`platform_prelude` in
 * `src-tauri/src/platform`).
 */
export const DEV_BUILD =
  import.meta.env.DEV ||
  (window as { __KIMOCHI_PLATFORM__?: { debug?: boolean } }).__KIMOCHI_PLATFORM__?.debug === true

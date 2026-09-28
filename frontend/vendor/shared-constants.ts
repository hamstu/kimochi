/**
 * VERBATIM COPY of `src/shared/constants.ts` from the Electron app (do not hand-edit).
 * Kept byte-identical apart from this header and relative import paths.
 */
/**
 * Centralized constants for the application
 * This file contains all URLs and other configuration values used throughout the app
 *
 * IMPORTANT: When changing URLs in this file, also update the Content Security Policy (CSP)
 * in the following HTML files if they contain the same URLs:
 * - src/renderer/overlay.html (connect-src)
 * - src/renderer/welcome.html (connect-src)
 */

const LOCAL_HOST = 'http://localhost'
const CLOUD_SERVER = 'https://kimochi-server.hamish.workers.dev'

// Server mode options
export type ServerMode = 'cloud' | 'local'
export const DEFAULT_SERVER_MODE: ServerMode = 'cloud'

// Server base URLs
export const SERVER_URLS = {
  local: `${LOCAL_HOST}:3000`,
  cloud: CLOUD_SERVER
} as const

// Helper to get API URLs based on server mode
export function getServerUrls(mode: ServerMode) {
  const baseUrl = SERVER_URLS[mode]
  return {
    GOOGLE_VISION: `${baseUrl}/detect-text`,
    TTS: `${baseUrl}/tts`
  }
}

// API URLs - External Services (legacy, for non-server endpoints)
export const API_URLS = {
  // Yomitan API (default local instance)
  YOMITAN: `${LOCAL_HOST}:19633`,
  YOMITAN_FALLBACK: `${LOCAL_HOST}:8765`,

  // Google Cloud Vision OCR service (default to cloud)
  GOOGLE_VISION: `${CLOUD_SERVER}/detect-text`,

  // TTS (Text-to-Speech) service (default to cloud)
  TTS: `${CLOUD_SERVER}/tts`,

  // EasyOCR service
  EASYOCR: `${LOCAL_HOST}:8000/ocr`,

  // WebSocket OCR service (OwOCR)
  WS_OCR: `ws://${LOCAL_HOST}:7331`
} as const

// Default Audio Settings
export const DEFAULT_VOICE_ID = 'j210dv0vWm7fCknyQpbA'

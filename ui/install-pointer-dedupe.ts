/**
 * Imported first by every window's entry, so its listeners run before any other: see
 * `pointer-dedupe.ts`.
 */
import { installPointerDedupe } from './pointer-dedupe.js'

installPointerDedupe()

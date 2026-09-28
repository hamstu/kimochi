/**
 * VERBATIM COPY of `src/renderer/src/constants/zIndex.ts` from the Electron app (do not hand-edit).
 * Kept byte-identical apart from this header and relative import paths.
 */
/** Stacking within the screen overlay (and local dialogs inside each native panel).
 * Ordinary windows are stacked by the operating system.
 */

// TextOverlay: OCR text displayed over the screen
// Screen markings appear above the text.
export const Z_INDEX_TEXT_OVERLAY = 100
export const Z_INDEX_TEXT_OVERLAY_CONTROLS = 101

// SourceHoverOverlay: Hover preview for crop region and window outline
// Above text overlay but below debug markings
export const Z_INDEX_HOVER_WINDOW_OUTLINE = 150
export const Z_INDEX_HOVER_CROP_REGION = 151

// DebugOverlay: Debug visualization boxes
// Slightly above text overlay but below selection overlays
export const Z_INDEX_DEBUG_WINDOW_OUTLINE = 199
export const Z_INDEX_DEBUG_SCAN_REGION = 200
export const Z_INDEX_DEBUG_TEXT_BOUNDS = 201
export const Z_INDEX_DEBUG_TEXT_BOXES = 202

// Crop/Selection overlays: Used during crop region editing
// Selection controls appear above screen markings.
export const Z_INDEX_CROP_OVERLAY = 6000
export const Z_INDEX_CROP_CONTROLS = 6001

// Select and Scan overlay
export const Z_INDEX_SELECT_SCAN_OVERLAY = 6000
export const Z_INDEX_SELECT_SCAN_CONTROLS = 6001

// Modals and popovers: Highest layer
export const Z_INDEX_MODAL = 9000

/* eslint @typescript-eslint/explicit-function-return-type: "off" -- Plain Node module. */
/**
 * Kimochi's edits to an extension's files as they are served (host/ext/patches.json), for the dev
 * server. The app applies the same list in src-tauri/src/extensions.rs `patched`; both serve a
 * file unpatched when a patch's `find` is not there exactly once.
 */
import { readFileSync } from 'node:fs'

export const PATCHES = JSON.parse(readFileSync(new URL('../host/ext/patches.json', import.meta.url), 'utf8')).patches

const occurrences = (text, find) => text.split(find).length - 1

/** `text` of engine `id`'s file `rel` with the patches applied, and which of them did not apply. */
export function applyPatches(id, rel, text) {
  const skipped = []
  for (const patch of PATCHES) {
    if (patch.engine !== id || patch.file !== rel) continue
    if (occurrences(text, patch.find) === 1) text = text.replace(patch.find, () => patch.replace)
    else skipped.push(patch.id)
  }
  return { text, skipped }
}

/** Whether engine `id`'s file `rel` has any patch, so a server need only read those files. */
export const patchesFile = (id, rel) => PATCHES.some((patch) => patch.engine === id && patch.file === rel)

/**
 * What stops a patch from applying to `text` (the pinned file), as messages: its `find` missing
 * or repeated, or something its replacement calls (`requires`) gone. Empty when it applies.
 */
export function patchProblems(patch, text) {
  const problems = []
  const found = occurrences(text, patch.find)
  if (found !== 1) problems.push(`${patch.id}: \`find\` occurs ${found} times in ${patch.engine}/${patch.file}, not once`)
  for (const name of patch.requires ?? []) {
    if (!text.includes(name)) problems.push(`${patch.id}: ${patch.engine}/${patch.file} no longer has \`${name}\``)
  }
  return problems
}

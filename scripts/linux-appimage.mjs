// Reproducible Linux AppImage repairs; no changes to application/library versions.
import { readFile, writeFile, copyFile, readdir, access } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'

const cache = path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'tauri')
const exists = async (file) => access(file).then(() => true, () => false)

// New GdkPixbuf uses Glycin and may no longer install the legacy loaders directory.
export async function prepareLinuxBundler() {
  const plugin = path.join(cache, 'linuxdeploy-plugin-gtk.sh')
  if (!(await exists(plugin))) return false
  const original = await readFile(plugin, 'utf8')
  if (original.includes('if [ -d "$gdk_pixbuf_binarydir" ]')) return false
  const start = original.search(/copy_(?:lib_)?tree "\$gdk_pixbuf_binarydir" "\$APPDIR\/"/)
  const end = original.indexOf('echo "Copying more libraries"', start)
  if (start < 0 || end < 0) return false
  const patched = original.slice(0, start) + 'if [ -d "$gdk_pixbuf_binarydir" ]; then\n' + original.slice(start, end) + 'else\n    echo "No legacy GdkPixbuf loaders directory; skipping it"\nfi\n\n' + original.slice(end)
  await writeFile(plugin, patched)
  console.log('Applied GTK packaging guard for optional legacy GdkPixbuf loaders.')
  return true
}

/** A patchelf-added program header must never overwrite the GNU symbol hash table. */
export function hashOverlapsHeaders(bytes) {
  if (bytes.length < 64 || bytes.toString('hex', 0, 4) !== '7f454c46' || bytes[4] !== 2 || bytes[5] !== 1) return false
  const sections = Number(bytes.readBigUInt64LE(40))
  const size = bytes.readUInt16LE(58)
  const count = bytes.readUInt16LE(60)
  const names = bytes.readUInt16LE(62)
  if (size < 64 || sections + count * size > bytes.length || names >= count) return false
  const stringsHeader = sections + names * size
  const strings = Number(bytes.readBigUInt64LE(stringsHeader + 24))
  const phStart = Number(bytes.readBigUInt64LE(32))
  const phEnd = phStart + bytes.readUInt16LE(54) * bytes.readUInt16LE(56)
  for (let index = 0; index < count; index++) {
    const header = sections + index * size
    const nameStart = strings + bytes.readUInt32LE(header)
    const nameEnd = bytes.indexOf(0, nameStart)
    if (bytes.toString('utf8', nameStart, nameEnd) !== '.gnu.hash') continue
    const hash = Number(bytes.readBigUInt64LE(header + 24))
    if (hash >= phStart && hash < phEnd) return true
  }
  return false
}

export async function repairLinuxAppImages({ target, release, env }) {
  const directory = path.resolve(process.env.CARGO_TARGET_DIR ?? 'src-tauri/target', target ?? '', release ? 'release' : 'debug', 'bundle/appimage')
  const entries = await readdir(directory)
  const appdirs = entries.filter((name) => name.endsWith('.AppDir'))
  const images = entries.filter((name) => name.endsWith('.AppImage'))
  if (appdirs.length !== 1 || images.length !== 1) throw new Error(`Expected one AppDir and AppImage in ${directory}`)
  const appdir = path.join(directory, appdirs[0])
  const libraries = path.join(appdir, 'usr/lib')
  const ldconfig = spawnSync('ldconfig', ['-p'], { encoding: 'utf8' })
  const originals = new Map([...ldconfig.stdout.matchAll(/^\s*(\S+)\s+.*=>\s+(\S+)$/gm)].map((match) => [match[1], match[2]]))
  for (const name of await readdir(libraries)) {
    if (!name.includes('.so')) continue
    const destination = path.join(libraries, name)
    const bytes = await readFile(destination).catch(() => null)
    if (!bytes || !hashOverlapsHeaders(bytes)) continue
    const original = originals.get(name)
    if (!original) throw new Error(`Corrupted GNU hash in ${name}, but original library not found`)
    const pristine = await readFile(original)
    if (hashOverlapsHeaders(pristine) || bytes.readUInt16LE(18) !== pristine.readUInt16LE(18)) throw new Error(`Unsafe original library for ${name}`)
    await copyFile(original, destination)
    console.log(`Restored ${name}: patchelf program headers overwrote its GNU hash table.`)
  }
  const layer = originals.get('libgtk-layer-shell.so.0')
  if (layer) {
    await copyFile(layer, path.join(libraries, 'libgtk-layer-shell.so.0'))
    console.log('Bundled optional GTK layer-shell runtime.')
  }
  const hook = path.join(appdir, 'apprun-hooks/linuxdeploy-plugin-gtk.sh')
  const script = await readFile(hook, 'utf8')
  await writeFile(hook, script.replace(/^export GDK_BACKEND=x11.*$/m, `# Respect an explicit backend; prefer native Wayland in a Wayland login.\nif [ -z "\${GDK_BACKEND:-}" ]; then\n    if [ "\${XDG_SESSION_TYPE:-}" = wayland ] || [ -n "\${WAYLAND_DISPLAY:-}" ]; then\n        GDK_BACKEND=wayland\n    else\n        GDK_BACKEND=x11\n    fi\nfi\nexport GDK_BACKEND`))
  const result = spawnSync(path.join(cache, 'linuxdeploy-plugin-appimage.AppImage'), [`--appdir=${appdir}`], {
    stdio: 'inherit', cwd: directory,
    env: { ...env, APPIMAGE_EXTRACT_AND_RUN: '1', LDAI_OUTPUT: path.join(directory, images[0]) }
  })
  if (result.error || result.status !== 0) throw result.error ?? new Error(`AppImage repack failed (${result.status})`)
}

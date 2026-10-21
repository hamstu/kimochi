// Reproducible Linux AppImage repairs; no changes to application/library versions.
import { readFile, writeFile, copyFile, readdir, access, mkdir, rename, rm, cp } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

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

// WebKit loads GStreamer elements dynamically; linuxdeploy cannot infer them from ELF dependencies.
export async function bundleLinuxAudio(appdir, env) {
  const variable = (name) => {
    const result = spawnSync('pkg-config', [`--variable=${name}`, 'gstreamer-1.0'], { encoding: 'utf8' })
    if (result.status !== 0 || !result.stdout.trim()) throw new Error(`GStreamer ${name} unavailable; install its development package`)
    return result.stdout.trim()
  }
  const plugins = variable('pluginsdir')
  const names = ['coreelements', 'app', 'playback', 'typefindfunctions', 'audioconvert', 'audioresample', 'volume', 'audiofx', 'debugutilsbad', 'autodetect', 'pulseaudio', 'audioparsers', 'id3demux', 'mpg123', 'wavparse']
  const destination = path.join(appdir, 'usr/lib/gstreamer-1.0')
  await mkdir(destination, { recursive: true })
  for (const name of names) {
    const source = path.join(plugins, `libgst${name}.so`)
    if (!(await exists(source))) throw new Error(`Missing ${source}; install GStreamer base/good/bad audio plugins`)
    await copyFile(source, path.join(destination, path.basename(source)))
  }
  const scanner = path.join(variable('pluginscannerdir'), 'gst-plugin-scanner')
  const scannerDirectory = path.join(appdir, 'usr/libexec/gstreamer-1.0')
  await mkdir(scannerDirectory, { recursive: true })
  await copyFile(scanner, path.join(scannerDirectory, 'gst-plugin-scanner'))
  // Deploy dependencies with the same bundler/exclusion policy as the main app.
  const arch = { arm64: 'aarch64', x64: 'x86_64' }[process.arch]
  const deployed = spawnSync(path.join(cache, `linuxdeploy-${arch}.AppImage`), ['--appimage-extract-and-run', `--appdir=${appdir}`, `--deploy-deps-only=${destination}`, `--deploy-deps-only=${scannerDirectory}`], { stdio: 'inherit', env: { ...env, APPIMAGE_EXTRACT_AND_RUN: '1' } })
  if (deployed.error || deployed.status !== 0) throw deployed.error ?? new Error(`GStreamer dependency deployment failed (${deployed.status})`)
  console.log(`Bundled ${names.length} GStreamer audio plugins and their scanner.`)
}

const avifSample = fileURLToPath(new URL('../src-tauri/src/platform/linux/testdata/sample.avif', import.meta.url))

/**
 * The build host's libavif, which the app links to decode dictionary AVIF images (Jitendex, the
 * recommended dictionary, ships them) where WebKitGTK cannot. linuxdeploy bundles it and its AV1
 * decoder like any linked library. Throws, naming the package, when the host lacks it or has a
 * libavif older than 1.0, whose ABI the app's bindings do not match.
 */
export function linuxAvifSource() {
  const version = spawnSync('pkg-config', ['--modversion', 'libavif'], { encoding: 'utf8' })
  if (version.status !== 0) throw new Error('libavif unavailable, which decodes dictionary images; install libavif-dev (Arch: libavif)')
  if (spawnSync('pkg-config', ['--atleast-version=1.0.0', 'libavif']).status !== 0) throw new Error(`libavif ${version.stdout.trim()} is older than 1.0; dictionary images need libavif 1.x`)
  return { version: version.stdout.trim() }
}

/**
 * Fails the build unless the AppDir carries libavif and its own binary decodes a sample AVIF with
 * an AV1 decoder, through AppRun, so with the libraries the AppImage will load.
 */
export async function verifyDictionaryImages(appdir, run = spawnSync) {
  const libraries = await readdir(path.join(appdir, 'usr/lib')).catch(() => [])
  if (!libraries.some((name) => /^libavif\.so\.\d+/.test(name))) throw new Error('AppImage carries no libavif; AVIF dictionary images would not load')
  const checked = run(path.join(appdir, 'AppRun'), ['--check-avif', avifSample], { encoding: 'utf8', env: { ...process.env, APPDIR: appdir } })
  const output = `${checked.stdout ?? ''}${checked.stderr ?? ''}`.trim()
  if (checked.error || checked.status !== 0) throw new Error(`The AppImage cannot decode AVIF: ${checked.error?.message ?? output}`)
  if (!/\[[^\]]*dec[^\]]*\]/.test(output)) throw new Error(`The AppImage's libavif has no AV1 decoder: ${output}`)
  console.log(output)
}

// `node scripts/linux-appimage.mjs --check-avif`: CI's quick check, right after installing packages.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--check-avif') {
  console.log(`AVIF dictionary images: libavif ${linuxAvifSource().version}`)
}

export async function repairLinuxAppImages({ target, release, env }) {
  const directory = path.resolve(process.env.CARGO_TARGET_DIR ?? 'src-tauri/target', target ?? '', release ? 'release' : 'debug', 'bundle/appimage')
  const entries = await readdir(directory)
  const appdirs = entries.filter((name) => name.endsWith('.AppDir'))
  const images = entries.filter((name) => name.endsWith('.AppImage'))
  if (appdirs.length !== 1 || images.length !== 1) throw new Error(`Expected one AppDir and AppImage in ${directory}`)
  const appdir = path.join(directory, appdirs[0])
  await bundleLinuxAudio(appdir, env)
  linuxAvifSource()
  // PipeWire loads its support.system implementation dynamically. The compiled-in
  // Ubuntu multiarch path is absent on SteamOS/Arch, even when PipeWire is installed.
  const spaDirectory = spawnSync('pkg-config', ['--variable=plugindir', 'libspa-0.2'], { encoding: 'utf8' })
  const spaSource = spaDirectory.stdout.trim()
  if (spaDirectory.status !== 0 || !spaSource) throw new Error('PipeWire SPA plugin directory unavailable')
  const spaDestination = path.join(appdir, 'usr/lib/spa-0.2/support')
  await cp(path.join(spaSource, 'support'), spaDestination, { recursive: true })
  const moduleDirectory = spawnSync('pkg-config', ['--variable=moduledir', 'libpipewire-0.3'], { encoding: 'utf8' }).stdout.trim()
  const pipewirePrefix = spawnSync('pkg-config', ['--variable=prefix', 'libpipewire-0.3'], { encoding: 'utf8' }).stdout.trim()
  if (!moduleDirectory || !pipewirePrefix) throw new Error('PipeWire runtime paths unavailable')
  const clientConfig = path.join(pipewirePrefix, 'share/pipewire/client.conf')
  const config = await readFile(clientConfig, 'utf8')
  const moduleDestination = path.join(appdir, 'usr/lib/pipewire-0.3')
  await mkdir(moduleDestination, { recursive: true })
  // Deploy only modules referenced by the matching client configuration, not
  // daemon services or unrelated Bluetooth/network audio backends.
  for (const name of new Set([...config.matchAll(/name\s*=\s*(libpipewire-module-[\w-]+)/g)].map(match => match[1]))) {
    await copyFile(path.join(moduleDirectory, `${name}.so`), path.join(moduleDestination, `${name}.so`))
  }
  const configDestination = path.join(appdir, 'usr/share/pipewire')
  await mkdir(configDestination, { recursive: true })
  await copyFile(clientConfig, path.join(configDestination, 'client.conf'))
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const spaDeployed = spawnSync(path.join(cache, `linuxdeploy-${arch}.AppImage`), ['--appimage-extract-and-run', `--appdir=${appdir}`, `--deploy-deps-only=${spaDestination}`, `--deploy-deps-only=${moduleDestination}`], { stdio: 'inherit', env: { ...env, APPIMAGE_EXTRACT_AND_RUN: '1' } })
  if (spaDeployed.error || spaDeployed.status !== 0) throw spaDeployed.error ?? new Error(`PipeWire SPA deployment failed (${spaDeployed.status})`)
  const libraries = path.join(appdir, 'usr/lib')
  // EGL/Mesa stays on the host. Its Wayland ABI must come from the host too:
  // SteamOS Mesa needs wl_display_create_queue_with_name, absent in Ubuntu's
  // bundled client library. Mixing them prevents WebKit from creating EGL.
  for (const name of await readdir(libraries)) {
    if (/^libwayland-(client|server|cursor|egl)\.so(?:\.|$)/.test(name)) {
      await rm(path.join(libraries, name));
      console.log(`Use host graphics stack: removed bundled ${name}.`)
    }
  }
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
  // linuxdeploy's generated AppRun sources only its registered GTK hook.
  // A separate hook added after deployment is never registered with AppRun.
  await writeFile(hook, (await readFile(hook, 'utf8')) + `
export GST_PLUGIN_SYSTEM_PATH_1_0="$APPDIR/usr/lib/gstreamer-1.0"
export GST_PLUGIN_SCANNER_1_0="$APPDIR/usr/libexec/gstreamer-1.0/gst-plugin-scanner"
export SPA_PLUGIN_DIR="$APPDIR/usr/lib/spa-0.2"
export PIPEWIRE_MODULE_DIR="$APPDIR/usr/lib/pipewire-0.3"
export PIPEWIRE_CONFIG_DIR="$APPDIR/usr/share/pipewire"
`)
  // Last, on the finished AppDir: its own binary decodes AVIF with the bundled libraries.
  await verifyDictionaryImages(appdir)
  const repacked = path.join(directory, `${images[0]}.repacked`)
  const result = spawnSync(path.join(cache, 'linuxdeploy-plugin-appimage.AppImage'), [`--appdir=${appdir}`], {
    stdio: 'inherit', cwd: directory,
    env: { ...env, APPIMAGE_EXTRACT_AND_RUN: '1', LDAI_OUTPUT: repacked }
  })
  if (result.error || result.status !== 0) throw result.error ?? new Error(`AppImage repack failed (${result.status})`)
  await rename(repacked, path.join(directory, images[0]))
  const packageScript = fileURLToPath(new URL('./steam-deck/package-gaming-mode.sh', import.meta.url))
  const packaged = spawnSync('sh', [packageScript, path.join(directory, images[0]), path.join(directory, images[0].replace(/\.AppImage$/, '-gaming-mode.tar.gz'))], { stdio: 'inherit', env })
  if (packaged.error || packaged.status !== 0) throw packaged.error ?? new Error(`Gaming Mode package failed (${packaged.status})`)
}

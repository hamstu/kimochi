/**
 * The Windows uninstaller's "Also remove my Kimochi settings and data" box (#219): Tauri's own
 * "Delete the application data" box, relabelled by src-tauri/nsis/{English,Japanese}.nsh, with
 * src-tauri/nsis/hooks.nsh removing what Kimochi keeps outside its two data folders.
 *
 * Those files lean on Tauri's NSIS template, which lives inside the Tauri CLI's native binary. The
 * template checks read it from the installed CLI, so a Tauri upgrade that renames a variable,
 * changes when app data is deleted, or adds an installer string fails here rather than quietly
 * shipping a box that does nothing, deletes data on update, or shows an empty label.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const nsis = path.join(root, 'src-tauri', 'nsis')
const read = (file) => fs.readFileSync(path.join(nsis, file), 'utf8').replace(/^﻿/, '')
const hooks = read('hooks.nsh')
/** NSIS code without its `;` comments. */
const code = hooks
  .split('\n')
  .filter((line) => !line.trim().startsWith(';'))
  .join('\n')

/** The NSIS template in whichever native Tauri CLI npm installed for this machine. */
function tauriTemplate() {
  const scope = path.join(root, 'node_modules', '@tauri-apps')
  if (!fs.existsSync(scope)) return null
  for (const dir of fs.readdirSync(scope).filter((d) => d.startsWith('cli-'))) {
    for (const file of fs.readdirSync(path.join(scope, dir)).filter((f) => f.endsWith('.node'))) {
      const text = fs.readFileSync(path.join(scope, dir, file)).toString('utf8')
      if (text.includes('Section Uninstall')) return text
    }
  }
  return null
}
const template = tauriTemplate()
const skip = template ? false : 'the Tauri CLI is not installed (npm install)'

/** LangString names (and values) a language file defines. */
function strings(text, lang) {
  const re = new RegExp(`^LangString (\\w+) \\$\\{LANG_${lang}\\} (".*")`, 'gm')
  return new Map([...text.matchAll(re)].map((m) => [m[1], m[2]]))
}

test('the Windows bundle uses the hooks and the relabelled strings', () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.windows.conf.json'), 'utf8'))
  const nsisConfig = config.bundle.windows.nsis
  assert.equal(nsisConfig.installerHooks, 'nsis/hooks.nsh')
  assert.deepEqual(nsisConfig.customLanguageFiles, { English: 'nsis/English.nsh', Japanese: 'nsis/Japanese.nsh' })
  for (const lang of nsisConfig.languages) assert.ok(nsisConfig.customLanguageFiles[lang], `${lang} is relabelled`)
  for (const file of [nsisConfig.installerHooks, ...Object.values(nsisConfig.customLanguageFiles)]) {
    assert.ok(fs.existsSync(path.join(root, 'src-tauri', file)), file)
  }
  // The updater runs the installer in passive mode; MSI would need its own uninstall handling.
  assert.deepEqual(config.bundle.targets, ['nsis'])
})

test('the box reads as an opt-in to remove Kimochi’s data, in English and Japanese', () => {
  assert.equal(
    strings(read('English.nsh'), 'ENGLISH').get('deleteAppData'),
    '"Also remove my Kimochi settings and data"'
  )
  assert.equal(strings(read('Japanese.nsh'), 'JAPANESE').get('deleteAppData'), '"Kimochi の設定とデータも削除する"')
  for (const file of ['English.nsh', 'Japanese.nsh']) {
    const values = [...strings(read(file), file === 'English.nsh' ? 'ENGLISH' : 'JAPANESE').values()].join('\n')
    assert.doesNotMatch(values, /\{\{/, `${file} has no bundler template placeholders`)
    // The bundler copies the file and adds a BOM of its own; a second one breaks makensis.
    assert.notEqual(fs.readFileSync(path.join(nsis, file))[0], 0xef, `${file} has no BOM`)
  }
})

test('the hook only runs when the box was ticked, and never during an update', () => {
  const body = code.slice(code.indexOf('!macro NSIS_HOOK_POSTUNINSTALL'))
  assert.match(
    body,
    /^!macro NSIS_HOOK_POSTUNINSTALL\n {2}\$\{If\} \$DeleteAppDataCheckboxState = 1\n {2}\$\{AndIf\} \$UpdateMode <> 1\n/
  )
  assert.match(body, /\$\{If\} \$LOCALAPPDATA != ""/)
  assert.doesNotMatch(code, /NSIS_HOOK_(PRE|POST)INSTALL|NSIS_HOOK_PREUNINSTALL/, 'no other hooks')
})

test('the hook deletes only Kimochi’s own, fully named folders and keys', () => {
  const removals = [...code.matchAll(/^\s*(RMDir|RmDir|Delete|DeleteRegKey|DeleteRegValue)\b(.*)$/gm)].map(
    (m) => `${m[1]}${m[2]}`
  )
  assert.deepEqual(removals, [
    'DeleteRegKey HKCU "${BROWSER}\\NativeMessagingHosts\\yomitan_api"',
    'DeleteRegKey /ifempty HKCU "${BROWSER}\\NativeMessagingHosts"',
    'RMDir /r "$LOCALAPPDATA\\kimochi-voicehook"'
  ])
  assert.doesNotMatch(code, /\*/, 'no wildcards')
  // A browser key goes only when it names the helper in Kimochi's own data folder.
  assert.match(code, /\$\{If\} \$R0 == "\$LOCALAPPDATA\\\$\{BUNDLEID\}\\yomitan-host\\yomitan_api\.json"/)
  assert.match(code, /\$\{OrIf\} \$R0 == "\$LOCALAPPDATA\\\$\{BUNDLEID\}\\yomitan-host\\yomitan_api_firefox\.json"/)
})

test('the hook’s browsers and paths match the app’s', () => {
  const host = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'reader', 'yomitan_host.rs'), 'utf8')
  const browsers = [...host.matchAll(/\("\w+", "[^"]+", r"(Software\\[^"]+)"\)/g)].map((m) => m[1])
  assert.ok(browsers.length >= 6)
  const hooked = [...code.matchAll(/KIMOCHI_FORGET_NATIVE_HOST "([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(hooked, browsers)
  assert.match(host, /pub const HOST_NAME: &str = "yomitan_api";/)
  const install = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'reader', 'yomitan_install.rs'), 'utf8')
  assert.match(install, /\.join\("yomitan-host"\)/)
  assert.match(install, /format!\("\{HOST_NAME\}_firefox\.json"\)/)
  const voice = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'sentence_audio', 'voice_hook.rs'), 'utf8')
  assert.match(voice, /var_os\("LOCALAPPDATA"\)[\s\S]{0,120}\.join\("kimochi-voicehook"\)/)
  const cli = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'cli', 'install.rs'), 'utf8')
  assert.match(cli, /local_dir\(\)\.map\(\|dir\| dir\.join\("bin"\)\)/)
  assert.match(code, /t "KIMOCHI_CLI_DIR", t "\$LOCALAPPDATA\\\$\{BUNDLEID\}\\bin"/)
})

test('Tauri still deletes app data only when the box is ticked and not updating', { skip }, () => {
  assert.match(template, /^Var DeleteAppDataCheckboxState$/m)
  assert.match(template, /^Var UpdateMode$/m)
  assert.match(
    template,
    /\$\{If\} \$DeleteAppDataCheckboxState = 1\r?\n\s*\$\{AndIf\} \$UpdateMode <> 1\r?\n[\s\S]{0,600}RmDir \/r "\$APPDATA\\\$\{BUNDLEID\}"\r?\n\s*RmDir \/r "\$LOCALAPPDATA\\\$\{BUNDLEID\}"/
  )
  // The box's state is read only when its page is left, and the page is skipped in passive mode
  // (silent mode shows no pages), so /S and /P keep the data.
  assert.match(template, /SendMessage \$DeleteAppDataCheckbox \$\{BM_GETCHECK\} 0 0 \$DeleteAppDataCheckboxState/)
  assert.match(template, /!define MUI_PAGE_CUSTOMFUNCTION_PRE un\.SkipIfPassive\r?\n!insertmacro MUI_UNPAGE_CONFIRM/)
  assert.equal(template.match(/DeleteAppDataCheckboxState/g).length, 3, 'declared, read from the box, tested once')
  // An update never runs the old uninstaller, and passes /UPDATE if it does.
  assert.match(
    template,
    /; In update mode, always proceeds without uninstalling\r?\n\s*\$\{If\} \$UpdateMode = 1\r?\n\s*Goto reinst_done/
  )
  assert.match(template, /\$\{GetOptions\} \$CMDLINE "\/UPDATE" \$UpdateMode/)
  // The hook runs after Tauri's own deletion, inside the uninstall section.
  const section = template.slice(
    template.indexOf('Section Uninstall'),
    template.indexOf('SectionEnd', template.indexOf('Section Uninstall'))
  )
  assert.ok(
    section.indexOf('!insertmacro NSIS_HOOK_POSTUNINSTALL') > section.indexOf('RmDir /r "$LOCALAPPDATA\\${BUNDLEID}"')
  )
})

test('the relabelled language files have every string Tauri’s own have', { skip }, () => {
  for (const [file, lang] of [
    ['English.nsh', 'ENGLISH'],
    ['Japanese.nsh', 'JAPANESE']
  ]) {
    const ours = strings(read(file), lang)
    const tauris = strings(template, lang)
    assert.ok(tauris.size > 20, `found Tauri's ${lang} strings`)
    assert.deepEqual([...ours.keys()].sort(), [...tauris.keys()].sort(), file)
    for (const [name, value] of tauris) {
      if (name === 'deleteAppData') continue
      assert.equal(ours.get(name), value.replaceAll('{{product_name}}', '${PRODUCTNAME}'), `${file}: ${name}`)
    }
  }
})

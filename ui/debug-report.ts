/**
 * Settings → About → Debug info: the native report (`debug_report`, COMMANDS.md → Debug info) as
 * Markdown for a Discord message or a GitHub issue. The summary comes first, readable at a
 * glance; the windows, settings and recent events follow in collapsed `<details>` blocks (GitHub
 * folds them, Discord shows them as text). The report arrives redacted; this only formats it.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Obj = { [key: string]: Json }

/** What `debug_report` answers; every field is optional so an older backend still formats. */
export interface DebugReport {
  generatedAt?: string
  app?: Obj
  os?: Obj
  hardware?: Obj
  displays?: Obj[]
  capture?: Obj
  ocr?: { selected?: Json; engines?: Obj; models?: Obj[]; cloudAccess?: Json }
  observer?: Json
  dictionary?: { selected?: Json; downloads?: Obj[] }
  session?: Obj
  settings?: Obj
  windows?: Obj[]
  verboseLogging?: boolean
  recentEvents?: Json[]
}

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const text = (value: Json | undefined, fallback = 'unknown'): string =>
  value === null || value === undefined || value === '' ? fallback : String(value)

const yesNo = (value: Json | undefined): string =>
  value === true ? 'yes' : value === false ? 'no' : 'unknown'

/** 34359738368 → "32 GB". */
export function formatBytes(bytes: Json | undefined): string {
  if (typeof bytes !== 'number' || !(bytes > 0)) return 'unknown'
  const gb = bytes / 1024 ** 3
  return gb >= 1 ? `${Math.round(gb)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

function display(item: Obj, index: number): string {
  const bounds = isObj(item.bounds) ? item.bounds : {}
  const scale = typeof item.scale_factor === 'number' ? `${Math.round(item.scale_factor * 100)}%` : '?'
  return `- Display ${index + 1}: ${text(bounds.width, '?')}×${text(bounds.height, '?')} at (${text(bounds.x, '?')}, ${text(bounds.y, '?')}), scale ${scale}`
}

function download(item: Obj): string {
  const state = text(item.state)
  const version = item.version ? ` ${String(item.version)}` : ''
  const problem = item.message ? ` (${String(item.message)})` : ''
  return `${text(item.name ?? item.engine)}${version}: ${state}${problem}`
}

function engine(name: string, value: Json): string {
  if (!isObj(value)) return `- ${name}: ${text(value)}`
  const available = value.available === true ? 'available' : value.available === false ? 'unavailable' : 'unknown'
  const reason = value.reason ? ` (${String(value.reason)})` : ''
  return `- ${name}: ${available}${reason}`
}

function focus(value: Json | undefined): string {
  if (!isObj(value)) return 'unknown'
  return [
    value.focused ? 'in front' : 'behind',
    value.present ? 'on screen' : 'not on screen (minimised, closed or elsewhere)',
    value.held ? 'held while Kimochi is in front' : '',
    value.covered ? 'a Kimochi window covers the text' : ''
  ]
    .filter(Boolean)
    .join(', ')
}

function windowLine(item: Obj): string {
  const bounds = isObj(item.bounds) ? item.bounds : null
  const state = [
    item.visible === true ? 'shown' : item.visible === false ? 'hidden' : '?',
    item.minimized === true ? 'minimised' : '',
    item.focused === true ? 'focused' : ''
  ]
    .filter(Boolean)
    .join(', ')
  const where = bounds ? ` ${text(bounds.width, '?')}×${text(bounds.height, '?')} at (${text(bounds.x, '?')}, ${text(bounds.y, '?')})` : ''
  return `- ${text(item.label)}: ${state}${where}`
}

function details(summary: string, body: string): string[] {
  return ['', '<details>', `<summary>${summary}</summary>`, '', body, '', '</details>']
}

/** The report as Markdown, for "Copy debug info" and the bundle's `report.md`. */
export function debugMarkdown(report: DebugReport): string {
  const { app = {}, os = {}, hardware = {}, capture = {}, ocr = {}, dictionary = {}, session = {} } = report
  const commit = app.commit ? `, commit ${String(app.commit)}` : ''
  const gpus = Array.isArray(hardware.gpus) && hardware.gpus.length > 0 ? hardware.gpus.map(String).join('; ') : 'unknown'
  const lines: string[] = [
    '### Kimochi debug info',
    `_Generated ${text(report.generatedAt)} (UTC)._`,
    '',
    `- **App:** Kimochi ${text(app.version)} (${text(app.build)}${commit}), Tauri ${text(app.tauri)}, WebView ${text(app.webview)}`,
    `- **OS:** ${text(os.name)} ${text(os.version, '')} (${text(os.arch)})${isObj(os.session) ? `, session ${JSON.stringify(os.session)}` : ''}`,
    `- **CPU:** ${text(hardware.cpu)} (${text(hardware.cores, '?')} threads), **memory:** ${formatBytes(hardware.memoryBytes)}`,
    `- **GPU:** ${gpus}`,
    `- **Capture:** permission ${text(capture.authorization)}, window capture ${yesNo(capture.windowCapture)}, hides its own windows ${yesNo(capture.excludesOwnWindows)}`,
    `- **OCR engine:** ${text(ocr.selected)}${ocr.cloudAccess !== undefined ? ` (Kimochi Cloud: ${yesNo(ocr.cloudAccess)})` : ''}`,
    `- **Dictionary:** ${text(dictionary.selected)}`,
    `- **Source:** ${text(session.sourceKind, 'none')}, ${focus(session.sourceFocus)}`,
    `- **Auto OCR:** ${session.autoOcr === true ? 'on' : session.autoOcr === false ? 'off' : 'unknown'}, status "${text(session.status, '')}"`,
    `- **Verbose logging:** ${report.verboseLogging ? 'on' : 'off'}`
  ]
  const displays = report.displays ?? []
  lines.push('', `**Displays (${displays.length})**`, ...(displays.length ? displays.map(display) : ['- none reported']))

  const engines = isObj(ocr.engines) ? Object.entries(ocr.engines).map(([name, value]) => engine(name, value)) : []
  const models = (ocr.models ?? []).map((item) => `- ${download(item)}`)
  const downloads = (dictionary.downloads ?? []).map((item) => `- ${download(item)}`)
  lines.push(
    '',
    '**OCR engines**',
    ...(engines.length ? engines : ['- none reported']),
    ...(models.length ? ['', '**OCR models**', ...models] : []),
    '',
    '**Dictionary engine downloads**',
    ...(downloads.length ? downloads : ['- none reported'])
  )

  const windows = report.windows ?? []
  lines.push(...details(`Kimochi windows (${windows.length})`, windows.map(windowLine).join('\n') || '- none'))
  lines.push(
    ...details(
      'Settings',
      Object.entries(report.settings ?? {})
        .map(([key, value]) => `- ${key}: ${JSON.stringify(value)}`)
        .join('\n') || '- none'
    )
  )
  const events = report.recentEvents ?? []
  lines.push(
    ...details(
      `Recent events (${events.length})`,
      ['```jsonl', ...events.map((event) => JSON.stringify(event)), '```'].join('\n')
    )
  )
  return lines.join('\n') + '\n'
}

import { readFile, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function summarize(records) {
  const passes = records.filter((r) => r.kind === 'first-pass')
  const count = (xs, key) =>
    Object.fromEntries(
      [...new Set(xs.map(key))].map((k) => [k, xs.filter((x) => key(x) === k).length])
    )
  const timing = (xs, key) => {
    const values = xs
      .map((r) => r[key])
      .filter((v) => typeof v === 'number' && Number.isFinite(v))
      .sort((a, b) => a - b)
    const at = (p) =>
      values.length ? Math.round(values[Math.ceil(p * values.length) - 1] * 10) / 10 : null
    return { samples: values.length, p50: at(0.5), p95: at(0.95), max: at(1) }
  }
  const decisions = records.filter((r) => r.kind === 'decision')
  const observations = new Map(passes.map((r) => [r.frameId, r]))
  const requestRows = records.filter((r) => r.kind === 'second-pass-start')
  return {
    session: records[0]?.session,
    from: records.length
      ? new Date(records.reduce((at, r) => Math.min(at, r.at), Infinity)).toISOString()
      : null,
    to: records.length
      ? new Date(records.reduce((at, r) => Math.max(at, r.at), -Infinity)).toISOString()
      : null,
    captures: passes.length,
    captureFailures: records.filter((r) => r.kind === 'capture-failed').length,
    firstPass: {
      pixelsChanged: passes.filter((r) => r.pixelsChanged === true).length,
      pixelChangesWithUnchangedText: passes.filter(
        (r) => r.pixelsChanged === true && r.normalizedTextChanged === false
      ).length,
      normalizedTextChanges: passes.filter((r) => r.normalizedTextChanged === true).length,
      numberOnlyChanges: passes.filter((r) => r.normalizedTextChanged === true && r.numericOnly)
        .length,
      punctuationOrWhitespaceOnly: passes.filter(
        (r) => r.rawTextChanged === true && r.normalizedTextChanged === false
      ).length,
      layoutOnly: passes.filter((r) => r.rawTextChanged === false && r.changedLines > 0).length,
      relations: count(passes, (r) => r.relation)
    },
    timingsMs: {
      captureRoundTrip: timing(passes, 'roundTripMs'),
      selectionLookup: timing(passes, 'selectionMs'),
      nativeCapture: timing(passes, 'captureMs'),
      catalog: timing(passes, 'resolveMs'),
      acquisition: timing(passes, 'acquisitionMs'),
      pixels: timing(passes, 'pixelsMs'),
      observerIncludingCacheHits: timing(passes, 'observerMs'),
      captureCompletionGap: timing(passes, 'completionGapMs'),
      secondPass: timing(
        records.filter((r) => r.kind === 'second-pass-end'),
        'durationMs'
      ),
      overlayApply: timing(
        records.filter((r) => r.kind === 'apply-end'),
        'durationMs'
      )
    },
    actualRequests: requestRows.length,
    queuedEvents: decisions.filter((r) => r.event.type === 'request' && r.event.queued).length,
    publicationDecisions: count(
      decisions.filter((r) => r.event.type === 'result'),
      (r) => (r.event.published ? 'publish' : 'refresh-only')
    ),
    applied: records.filter((r) => r.kind === 'apply-end').length,
    skips: count(
      decisions.filter((r) => r.event.type === 'skip'),
      (r) => r.event.reason
    ),
    errorsByStage: count(
      decisions.filter((r) => r.event.type === 'error'),
      (r) => r.event.stage
    ),
    droppedRecords: records.reduce((sum, r) => sum + (r.droppedRecords ?? 0), 0),
    markers: records
      .filter((r) => r.kind === 'marker')
      .map((r) => ({ at: new Date(r.at).toISOString(), note: r.note })),
    requests: requestRows.map((r) => ({
      at: new Date(r.at).toISOString(),
      frameId: r.frameId,
      firstPassRelation: observations.get(r.frameId)?.relation ?? 'not retained in trace',
      normalizedTextId: observations.get(r.frameId)?.normalizedTextId ?? null
    }))
  }
}

async function main() {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
        : (process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'))
  const directory = join(base, 'dev.kimochi.app')
  const records = []
  let malformed = 0
  for (const name of ['auto-ocr-trace.1.jsonl', 'auto-ocr-trace.jsonl']) {
    let contents
    try {
      contents = await readFile(join(directory, name), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    for (const line of contents.split('\n').filter(Boolean)) {
      try {
        records.push(JSON.parse(line))
      } catch {
        malformed++
      }
    }
  }
  if (!records.length) {
    console.log('No trace yet. Start the instrumented app and enable Auto OCR.')
    return
  }
  const sessions = records.filter((r) => r.kind === 'first-pass')
  const session = (sessions.at(-1) ?? records.at(-1)).session
  const selected = records
    .filter((r) => r.session === session)
    .sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0))
  if (process.argv[2] === '--mark') {
    const note = process.argv.slice(3).join(' ').trim()
    if (!note) throw new Error('Provide a short test note after --mark.')
    const at = Date.now()
    await appendFile(
      join(directory, 'auto-ocr-trace.jsonl'),
      JSON.stringify({ schema: 1, session, kind: 'marker', at, note: note.slice(0, 500) }) + '\n'
    )
    console.log(`Marked ${new Date(at).toLocaleTimeString()}: ${note.slice(0, 500)}`)
    return
  }
  console.log(
    JSON.stringify({ directory, malformedLines: malformed, ...summarize(selected) }, null, 2)
  )
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}

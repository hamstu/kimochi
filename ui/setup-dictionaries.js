/* eslint @typescript-eslint/explicit-function-return-type: off */
/**
 * App-owned setup jobs: imports outlive the requesting panel and its relay timeout.
 *
 * The quick setup's catalogue is per language (`language`, a code from ui/languages.ts; an entry
 * without one is offered for every language). Only Japanese has one (Jitendex): for another
 * language the guide sends the reader to Yomitan's own dictionary list instead.
 */
export const RECOMMENDED_DICTIONARIES = [
  {
    id: 'jitendex',
    language: 'ja',
    title: 'Jitendex',
    titlePrefix: 'Jitendex.org',
    description: 'Japanese–English definitions.',
    url: 'https://github.com/stephenmk/stephenmk.github.io/releases/latest/download/jitendex-yomitan.zip'
  }
]

export function createDictionarySetup({
  api,
  fetchArchive,
  importArchive,
  countEntries,
  catalog = RECOMMENDED_DICTIONARIES
}) {
  const jobs = new Map()
  let serial = 0
  let running = null
  // The most recent job, running or not: a guide window that was reloaded, hidden or left for
  // another step picks its progress (or its outcome) back up from `catalog`.
  let latest = null
  async function run(job, recommended) {
    try {
      const existing = await api('getDictionaryInfo')
      let title = existing.find(
        (entry) => entry.title.startsWith(recommended.titlePrefix) && entry.importSuccess !== false
      )?.title
      if (!title) {
        if (existing.some((entry) => entry.title.startsWith(recommended.titlePrefix)))
          throw Error(
            `An incomplete ${recommended.title} import already exists. Remove it in dictionary settings, then retry.`
          )
        job.stage = 'downloading'
        const response = await fetchArchive(recommended.url)
        if (!response.ok) throw Error(`Dictionary download returned HTTP ${response.status}`)
        job.stage = 'importing'
        const imported = await importArchive(await response.arrayBuffer(), (progress) => {
          job.progress = progress
        })
        if (imported.errors?.length)
          throw Error(imported.errors.map((error) => error.message || String(error)).join('; '))
        title = imported.result?.title
        if (!title) throw Error('Dictionary import did not return a title')
      }
      job.stage = 'verifying'
      const verified = (await api('getDictionaryInfo')).find((item) => item.title === title)
      if (verified?.importSuccess !== true) throw Error("Dictionary import didn't finish.")
      job.entries = await countEntries(title)
      if (!(job.entries > 0)) throw Error('Dictionary contains no term entries')
      job.stage = 'enabling'
      const options = await api('optionsGetFull')
      const profile = options.profiles[options.profileCurrent].options
      const index = profile.dictionaries.findIndex((item) => item.name === title)
      const path = `profiles[${options.profileCurrent}].options.dictionaries`
      const target =
        index >= 0
          ? {
              scope: 'global',
              action: 'set',
              path: `${path}[${index}].enabled`,
              value: true
            }
          : {
              scope: 'global',
              action: 'splice',
              path,
              start: profile.dictionaries.length,
              deleteCount: 0,
              items: [
                {
                  name: title,
                  alias: title,
                  partsOfSpeechFilter: true,
                  useDeinflections: true,
                  enabled: true,
                  allowSecondarySearches: false,
                  definitionsCollapsible: 'not-collapsible',
                  styles: ''
                }
              ]
            }
      const results = await api('modifySettings', {
        targets: [target],
        source: 'kimochi-setup'
      })
      if (results?.some((result) => result.error))
        throw Error('Could not enable dictionary: ' + JSON.stringify(results))
      await api('triggerDatabaseUpdated', {
        type: 'dictionary',
        cause: 'import'
      })
      job.stage = 'complete'
      job.title = title
    } catch (error) {
      job.stage = 'failed'
      job.error = error.message || String(error)
    } finally {
      running = null
    }
  }
  return {
    handles: (action) => action === '__setupDictionaries',
    async handle({ command, id, dictionaryId, text, language } = {}) {
      if (command === 'active') return running ? { ...jobs.get(running) } : null
      if (command === 'practice') {
        // The word to try (the language's sample word, ui/sample-words.ts); Japanese by default.
        const word = typeof text === 'string' && text.trim() ? text.trim().slice(0, 32) : '日本語'
        const result = await api('termsFind', {
          text: word,
          details: { matchType: 'exact', deinflect: true },
          optionsContext: { current: true }
        })
        return {
          text: word,
          matches: result.dictionaryEntries?.length ?? 0
        }
      }
      if (command === 'catalog') {
        // What is installed, and which of it the current profile looks words up with, so the
        // guide offers a dictionary only to someone who has none ready.
        const dictionaries = await api('getDictionaryInfo')
        const options = await api('optionsGetFull')
        const profile = options?.profiles?.[options.profileCurrent]?.options
        const enabled = new Set((profile?.dictionaries ?? []).filter((item) => item.enabled).map((item) => item.name))
        // The quick setup for the language being learned (Japanese when none is named).
        const learning = typeof language === 'string' ? language : 'ja'
        return {
          catalog: catalog.filter((entry) => !entry.language || entry.language === learning),
          job: latest && jobs.has(latest) ? { ...jobs.get(latest) } : null,
          dictionaries: dictionaries.map((item) => ({
            ...item,
            enabled: enabled.has(item.title)
          }))
        }
      }
      if (command === 'status') {
        const job = jobs.get(id)
        if (!job) throw Error('Unknown dictionary setup job')
        return { ...job }
      }
      if (command !== 'start') throw Error('Unknown dictionary setup command')
      const recommended = catalog.find((entry) => entry.id === dictionaryId)
      if (!recommended) throw Error('Unknown recommended dictionary')
      if (running) {
        if (jobs.get(running).dictionaryId !== dictionaryId)
          throw Error('Finish the current dictionary setup before starting another.')
        return { id: running }
      }
      const job = {
        id: `dictionary-${++serial}`,
        dictionaryId,
        stage: 'starting'
      }
      jobs.set(job.id, job)
      running = job.id
      latest = job.id
      void run(job, recommended)
      return { id: job.id }
    }
  }
}

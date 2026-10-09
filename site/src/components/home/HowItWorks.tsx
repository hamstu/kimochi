const STEPS = [
  {
    n: '一',
    title: 'Pick a source',
    body: 'Choose the game’s window or a screen, and crop to the text box if you like.'
  },
  {
    n: '二',
    title: 'Scan, or let it watch',
    body: 'Press Scan for a line, or turn on Auto OCR and it reads each new line as it settles.'
  },
  {
    n: '三',
    title: 'Read in place',
    body: 'The overlay sits on the game and the Log keeps the whole session behind it.'
  },
  {
    n: '四',
    title: 'Look up, listen, keep',
    body: 'Open a word’s reading, hear it, add it to Anki or to the session’s notebook.'
  }
]

export function HowItWorks() {
  return (
    <ol className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
      {STEPS.map((s, i) => (
        <li key={s.title} className="border-t border-hairline pt-5">
          <p className="flex items-baseline gap-2">
            <span lang="ja" className="text-[1.75rem] leading-none font-medium text-accent-ink">
              {s.n}
            </span>
            <span className="sr-only">Step {i + 1}:</span>
          </p>
          <h3 className="mt-4 text-heading text-ink">{s.title}</h3>
          <p className="mt-2 text-body text-ink-2">{s.body}</p>
        </li>
      ))}
    </ol>
  )
}

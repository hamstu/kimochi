import { useState, type ReactNode } from 'react'
import { LiveDemo } from '../../demo/LiveDemo'
import { useGuessedPlatform } from '../../demo/env'
import { AppleMark, DeckMark, LinuxMark, WindowsMark } from '../PlatformMarks'
import { PlatformStrip } from './PlatformStrip'

type Tab = 'desktop' | 'gaming'

/**
 * "Runs on", then the live preview: a Desktop tab dressed as the visitor's own OS, and Gaming mode
 * (a handheld in Steam Deck's Gaming Mode). `id="demo"` is the header nav's anchor.
 */
export function DemoShowcase() {
  const [tab, setTab] = useState<Tab>('desktop')
  const desktop = useGuessedPlatform()
  const mark = desktop === 'windows' ? <WindowsMark className="size-4" /> : desktop === 'linux' ? <LinuxMark className="size-4" /> : <AppleMark className="size-4" />
  const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: 'desktop', label: 'Desktop', icon: mark },
    { id: 'gaming', label: 'Handheld-Mode', icon: <DeckMark className="size-4" /> }
  ]
  return (
    <section id="demo" aria-labelledby="demo-heading">
      <PlatformStrip />
      <div className="container-page pt-16 pb-16 md:pt-24 md:pb-24">
        <header className="mb-8 flex flex-col gap-6 md:mb-10 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl">
            <p className="mb-3 text-meta tracking-[0.08em] text-accent-ink uppercase">デモを試す</p>
            <h2 id="demo-heading" className="text-title text-ink">
              Try the Live Demo
            </h2>
          </div>
          <div role="tablist" aria-label="Preview" className="flex shrink-0 gap-1 self-start rounded-lg border border-hairline bg-bar p-1 md:self-auto">
            {tabs.map((t) => {
              const selected = t.id === tab
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`demo-tab-${t.id}`}
                  aria-selected={selected}
                  aria-controls="demo-stage"
                  onClick={() => setTab(t.id)}
                  className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-small font-medium transition-colors duration-100 ${
                    selected ? 'bg-raised text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08),inset_0_0_0_1px_var(--k-line)]' : 'text-ink-2 hover:text-ink'
                  }`}
                >
                  <span className={selected ? 'text-ink' : 'text-ink-3'}>{t.icon}</span>
                  {t.label}
                </button>
              )
            })}
          </div>
        </header>
        <div id="demo-stage" role="tabpanel" aria-labelledby={`demo-tab-${tab}`}>
          <LiveDemo platform={tab === 'gaming' ? 'deck' : desktop} />
        </div>
      </div>
    </section>
  )
}

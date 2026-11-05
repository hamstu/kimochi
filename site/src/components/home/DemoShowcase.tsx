import { useState, type ReactNode } from 'react'
import { LiveDemo } from '../../demo/LiveDemo'
import { useGuessedPlatform } from '../../demo/env'
import { AppleMark, DeckMark, LinuxMark, WindowsMark } from '../PlatformMarks'
import { PlatformStrip } from './PlatformStrip'

type Tab = 'desktop' | 'hook' | 'gaming'

/**
 * "Runs on", then the live preview: OCR (a desktop dressed as the visitor's own OS, Auto OCR reading
 * the game), Text Hooker (a Windows desktop, the game hooked), and Handheld mode (Steam Deck's
 * Gaming Mode). `id="demo"` is the header nav's anchor.
 */
export function DemoShowcase() {
  const [tab, setTab] = useState<Tab>('desktop')
  const desktop = useGuessedPlatform()
  const mark = desktop === 'windows' ? <WindowsMark className="size-5" /> : desktop === 'linux' ? <LinuxMark className="size-5" /> : <AppleMark className="size-5" />
  const tabs: { id: Tab; label: string; icon: ReactNode }[] = [
    { id: 'desktop', label: 'OCR', icon: mark },
    { id: 'hook', label: 'Text Hooker', icon: <WindowsMark className="size-5" /> },
    { id: 'gaming', label: 'Handheld mode', icon: <DeckMark className="size-5" /> }
  ]
  return (
    <section id="demo" aria-labelledby="demo-heading">
      <PlatformStrip />
      <div className="container-page pt-16 pb-16 md:pt-24 md:pb-24">
        <header className="mb-8 flex flex-col gap-6 md:mb-10 md:flex-row md:items-end md:justify-between">
          <div className="max-w-3xl">
            <p className="mb-3 text-meta tracking-[0.08em] text-accent-ink uppercase">デモを試す</p>
            <h2 id="demo-heading" className="text-title text-ink">
              Preview
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
          <LiveDemo platform={tab === 'gaming' ? 'deck' : tab === 'hook' ? 'windows' : desktop} input={tab === 'hook' ? 'hook' : 'ocr'} />
        </div>
      </div>
    </section>
  )
}

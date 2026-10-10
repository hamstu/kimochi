import { useState } from 'react'
import { LiveDemo } from '../../demo/LiveDemo'
import { guessPlatform, type Platform } from '../../demo/env'
import { PlatformStrip } from './PlatformStrip'

/**
 * The "Runs on" strip and the live demo under it: the strip is the demo's platform selector,
 * starting on the visitor's OS. `id="demo"` is the header nav's anchor.
 */
export function DemoShowcase() {
  const [platform, setPlatform] = useState<Platform>(guessPlatform)
  return (
    <section id="demo" aria-label="Live demo">
      <PlatformStrip value={platform} onChange={setPlatform} />
      <div id="demo-stage" role="tabpanel" aria-labelledby={`platform-${platform}`} className="container-page pt-8 pb-16 md:pt-10 md:pb-24">
        <LiveDemo platform={platform} />
      </div>
    </section>
  )
}

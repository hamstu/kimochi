import { DownloadButton } from '../components/DownloadButton'
import { DiscordButton } from '../components/DiscordButton'
import { DemoShowcase } from '../components/home/DemoShowcase'
import { Section } from '../components/Section'
import { FeatureGrid } from '../components/home/FeatureGrid'
import { Hero } from '../components/home/Hero'
import { HowItWorks } from '../components/home/HowItWorks'
import { OpenSource } from '../components/home/OpenSource'
import { AboutMe } from '../components/home/AboutMe'
import { Testimonials } from '../components/home/TestimonialsSection'
import { HomeFaq } from '../components/home/HomeFaq'

/**
 * Home. Section order: hero, the platform strip + live demo (DemoShowcase), features, how it
 * works, free and open source with the plans (OpenSource), who makes it (AboutMe), testimonials
 * (hidden while empty), the first FAQ questions, download. The header and footer nav (NAV_LINKS in
 * Layout.tsx) follow this order and link to the section ids: keep them in step. Feature copy and visuals: src/components/home/features.ts. Quotes:
 * src/components/home/testimonials.ts.
 */
export function Home() {
  return (
    <>
      <Hero />
      <DemoShowcase />

      <Section
        id="features"
        divider
        eyebrow="主な機能"
        heading="Features"
        lede="Screen capture, OCR, an overlay on your game, dictionaries, a reading log and Anki cards, all in one clean, simple app."
      >
        <FeatureGrid />
      </Section>

      <Section id="how" divider eyebrow="ご利用の流れ" heading="How it Works">
        <HowItWorks />
      </Section>

      <Section
        id="open-source"
        divider
        eyebrow="無料・オープンソース"
        heading="Free and open source"
        lede="Kimochi is completely free and open source. Download it, read the code, change it, share it. There’s an optional paid plan for a few extras that cost money to run."
      >
        <OpenSource />
      </Section>

      <AboutMe />

      <Testimonials />

      <Section id="faq" divider eyebrow="よくある質問" heading="Questions">
        <HomeFaq />
      </Section>

      <Section
        id="download"
        align="center"
        eyebrow="ダウンロード"
        heading="I hope you'll give it a try."
        lede="Free, for macOS, Windows and Linux."
      >
        <div className="flex flex-wrap items-start justify-center gap-4">
          <DownloadButton align="center" />
          <DiscordButton size="lg" />
        </div>
      </Section>
    </>
  )
}

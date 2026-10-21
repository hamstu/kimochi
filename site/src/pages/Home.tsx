import { DownloadButton } from '../components/DownloadButton'
import { DemoShowcase } from '../components/home/DemoShowcase'
import { Section } from '../components/Section'
import { FeatureGrid } from '../components/home/FeatureGrid'
import { Hero } from '../components/home/Hero'
import { HowItWorks } from '../components/home/HowItWorks'
import { OpenSource } from '../components/home/OpenSource'
import { AboutMe } from '../components/home/AboutMe'
import { Testimonials } from '../components/home/TestimonialsSection'
import { WhatIsKimochi } from '../components/home/WhatIsKimochi'
import { HomeFaq } from '../components/home/HomeFaq'

/**
 * Home. Section order: hero, what is Kimochi (one plain paragraph), the platform strip + live demo (DemoShowcase), features, how it
 * works, free and open source (OpenSource), who makes it (AboutMe), testimonials (hidden while empty), the first FAQ questions, download. Keep the ids features, demo and download: the header nav links
 * to them. Feature copy and visuals: src/components/home/features.ts. Quotes:
 * src/components/home/testimonials.ts.
 */
export function Home() {
  return (
    <>
      <Hero />
      <WhatIsKimochi />
      <DemoShowcase />

      <Section
        id="features"
        divider
        eyebrow="主な機能"
        heading="Features"
        lede="Kimochi is packed with useful features, all bundled into a beautiful, clean interface"
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
        {/* TODO(hamish): the download (GitHub releases of the private repo) 404s for visitors. Make
            the repo public, or replace this with launch sign-up once you pick an email service. */}
        <DownloadButton align="center" />
      </Section>
    </>
  )
}

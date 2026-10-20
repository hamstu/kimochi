import { DownloadButton } from '../components/DownloadButton'
import { DemoShowcase } from '../components/home/DemoShowcase'
import { Section } from '../components/Section'
import { FeatureGrid } from '../components/home/FeatureGrid'
import { Hero } from '../components/home/Hero'
import { HowItWorks } from '../components/home/HowItWorks'
import { Testimonials } from '../components/home/TestimonialsSection'

/**
 * Home. Section order: hero, the platform strip + live demo (DemoShowcase), features, how it
 * works, testimonials (hidden while empty), download. Keep the ids features, demo and download: the header nav links
 * to them. Feature copy and visuals: src/components/home/features.ts. Quotes:
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
        lede="Kimochi is packed with useful features, all bundled into a beautiful, clean interface"
      >
        <FeatureGrid />
      </Section>

      <Section id="how" divider eyebrow="ご利用の流れ" heading="How it Works">
        <HowItWorks />
      </Section>

      <Testimonials />

      <Section
        id="download"
        align="center"
        eyebrow="ダウンロード"
        heading="I hope you'll give it a try."
        lede="Free, for macOS, Windows and Linux."
      >
        <DownloadButton align="center" />
      </Section>
    </>
  )
}

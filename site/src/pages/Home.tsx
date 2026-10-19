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
        eyebrow="Features"
        heading="Stays out of your way"
        lede="A few small windows that sit beside your game."
      >
        <FeatureGrid />
      </Section>

      <Section id="how" divider eyebrow="How it works" heading="Pretty simple, really">
        <HowItWorks />
      </Section>

      <Testimonials />

      <Section
        id="download"
        align="center"
        eyebrow="Download"
        heading="Give it a go"
        lede="Free, for macOS, Windows and Linux."
      >
        <DownloadButton align="center" />
      </Section>
    </>
  )
}

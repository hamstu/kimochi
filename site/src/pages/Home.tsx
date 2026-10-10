import { DownloadButton } from '../components/DownloadButton'
import { DemoShowcase } from '../components/home/DemoShowcase'
import { Section } from '../components/Section'
import { FeatureGrid } from '../components/home/FeatureGrid'
import { Hero } from '../components/home/Hero'
import { HowItWorks } from '../components/home/HowItWorks'
import { PrivacyNote } from '../components/home/PrivacyNote'
import { Testimonials } from '../components/home/TestimonialsSection'

/**
 * Home. Section order: hero, the platform strip + live demo (DemoShowcase), features, how it
 * works, privacy, testimonials (hidden while empty), download. Keep the ids features, demo and download: the header nav links
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
        heading="Everything beside the game, nothing in the way"
        lede="Small, quiet windows around the one you are playing: capture, overlay, transcript, dictionary and notebook, joined up."
      >
        <FeatureGrid />
      </Section>

      <Section id="how" divider eyebrow="How it works" heading="Four steps, then you just read">
        <HowItWorks />
      </Section>

      <Section tone="bar">
        <PrivacyNote />
      </Section>

      <Testimonials />

      <Section
        id="download"
        align="center"
        eyebrow="Download"
        heading="Start reading"
        lede="Builds are published on GitHub for macOS, Windows and Linux. Until the first tagged release, the button offers the latest development build, rebuilt from every change."
      >
        <DownloadButton align="center" />
      </Section>
    </>
  )
}

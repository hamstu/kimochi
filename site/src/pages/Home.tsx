import { DownloadButton } from '../components/DownloadButton'
import { Section } from '../components/Section'
import { FeatureGrid } from '../components/home/FeatureGrid'
import { Hero } from '../components/home/Hero'
import { HowItWorks } from '../components/home/HowItWorks'
import { PlatformStrip } from '../components/home/PlatformStrip'
import { PrivacyNote } from '../components/home/PrivacyNote'
import { Testimonials } from '../components/home/TestimonialsSection'
import { LiveDemo } from '../demo/LiveDemo'

/**
 * Home. Section order: hero, platforms, demo, features, how it works, privacy, testimonials
 * (hidden while empty), download. Keep the ids features, demo and download: the header nav links
 * to them. Feature copy and visuals: src/components/home/features.ts. Quotes:
 * src/components/home/testimonials.ts.
 */
export function Home() {
  return (
    <>
      <Hero />
      <PlatformStrip />

      <Section
        id="demo"
        eyebrow="Demo"
        heading="See it read"
        lede="A scene, the overlay on top and the Log beside it. Point at a word to look it up, the way you would in a game."
      >
        <LiveDemo />
      </Section>

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

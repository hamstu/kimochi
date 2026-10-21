/**
 * The plain-language answer to "What is Kimochi?", high on the home page so people (and the
 * engines that quote pages) get the whole picture in one paragraph.
 */
export function WhatIsKimochi() {
  return (
    <section id="what-is-kimochi" aria-labelledby="what-heading" className="border-t border-hairline">
      <div className="container-page max-w-3xl py-12 text-center md:py-16">
        <h2 id="what-heading" className="text-heading text-ink">
          What is Kimochi?
        </h2>
        <p className="mt-3 text-body text-ink-2">
          Kimochi is a free, open-source (GPL-3.0) desktop app for macOS, Windows and Linux that helps you read
          Japanese in games. It reads the Japanese text on your screen with OCR, draws it back over the game, and
          lets you hover any word to look it up in Yomitan, Hachidori or 10ten and save it to Anki. It works on
          visual novels, manga and videos too, keeps a log of every line, and has a Gaming Mode for the Steam
          Deck. It’s made by Hamish Macpherson, an independent developer in Canada.
        </p>
      </div>
    </section>
  )
}

/**
 * Who makes Kimochi: a full-bleed band in the app icon's blue, Hamish's photo beside a hello in a
 * handwritten face (Caveat) and a few lines about the maker. Copy is a first draft for Hamish to
 * rewrite. The photo is public/hamish.jpg (320 px square, shown at up to 160).
 */
export function AboutMe() {
  return (
    <section id="about" aria-labelledby="about-heading" className="kd-about relative overflow-hidden text-white">
      <div className="container-page relative max-w-4xl py-20 md:grid md:grid-cols-[10rem_1fr] md:gap-12 md:py-28">
        <img
          src="/hamish.jpg"
          alt="Hamish, smiling, in a cap"
          width={160}
          height={160}
          loading="lazy"
          className="size-28 rounded-full object-cover shadow-[0_18px_40px_-12px_rgb(0_0_0/0.45)] ring-4 ring-white/25 md:mt-10 md:size-40"
        />
        <div className="mt-8 md:mt-0">
          <p className="text-meta tracking-[0.08em] text-white/70 uppercase">Who am I?</p>
          <h2 id="about-heading" className="mt-4 font-script text-[3.5rem] leading-[1] font-semibold md:text-[4.75rem]">
            Hey, I’m Hamish.
          </h2>
          <div className="mt-8 flex flex-col gap-4 text-lede text-white/85">
            <p>I’m just a dude with a family, a day job, and a long-time love of Japanese that I chip away at on the side, mostly through Anime, Manga, and Games. 🎮</p>
            <p>Kimochi started as the tool I wanted for myself: something clean and simple that reads the game for me, gets out of the way, and lets me look up the word I’m stuck on without breaking the flow.</p>
            <p>It’s made out of love. If it helps you read a little more Japanese, that’s the whole point. 頑張って!</p>
          </div>
        </div>
      </div>
    </section>
  )
}

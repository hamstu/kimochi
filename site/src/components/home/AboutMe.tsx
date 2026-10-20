/**
 * Who makes Kimochi: a full-bleed band in the app icon's blue, a hello in a handwritten face
 * (Caveat) and a few lines about the maker. Copy is a first draft for Hamish to rewrite.
 */
export function AboutMe() {
  return (
    <section id="about" aria-labelledby="about-heading" className="kd-about relative overflow-hidden text-white">
      <div className="container-page relative max-w-3xl py-20 md:py-28">
        <p className="text-meta tracking-[0.08em] text-white/70 uppercase">Who am I?</p>
        <h2 id="about-heading" className="mt-4 font-script text-[3.5rem] leading-[1] font-semibold md:text-[4.75rem]">
          Hey, I’m Hamish.
        </h2>
        <div className="mt-8 flex flex-col gap-4 text-lede text-white/85">
          <p>
            I’m just a regular guy with a family, a day job, and a long-running love of Japanese that I chip
            away at on the side, mostly through games.
          </p>
          <p>
            Kimochi started as the tool I wanted for myself: something that reads the game for me, gets out of
            the way, and lets me look up the word I’m stuck on without breaking the moment.
          </p>
          <p>
            It’s made out of love, not for a company. If it helps you read a little more Japanese, that’s the
            whole point.
          </p>
        </div>
      </div>
    </section>
  )
}

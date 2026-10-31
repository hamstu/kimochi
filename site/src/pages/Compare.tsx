import { Link } from "react-router";
import { Prose } from "../components/Prose";

/**
 * /compare: a short, plain answer to "which tool should I use?", linking out to each project rather
 * than keeping a feature table in step with them. The question is the first h2, so search and AI
 * answers can quote the paragraphs under it.
 */
export function Compare() {
  return (
    <Prose
      title="Kimochi vs GameSentenceMiner, owocr and YomiNinja"
      lede="There are tons of awesome tools for reading Japanese games with OCR. Pick whatever suits you best."
      page="/compare"
    >
      <h2 id="which">
        Which is better for reading Japanese games: Kimochi, GameSentenceMiner,
        owocr, YomiNinja, etc?
      </h2>
      <p>
        First of all, Kimochi was really inspired by all of these apps. So
        credit where credit is due! 🙏
      </p>
      <p>So how do you decide? To be honest, it depends on what you want.</p>
      <ul>
        <li>
          <a href="https://github.com/bpwhelan/GameSentenceMiner">
            GameSentenceMiner
          </a>{" "}
          is probably the best choice if you like being in full control and
          having all the bells and whistles. It has more advanced Anki card
          enrichment, automatic game pausing, and even built in text-hooking.
          It&rsquo;s really well maintained and is always getting new updates and
          features.
        </li>
        <li>
          <a href="https://github.com/AuroraWright/owocr">owocr</a> is a lovely
          little CLI tool for OCR that is perfect for minimal setups (e.g., pair
          it with your own Yomitan setup and a text hooking page.) It has a great
          selection of OCR models too.
        </li>
        <li>
          <a href="https://github.com/matt-m-o/YomiNinja">YomiNinja</a> is a free
          overlay with Yomitan and 10ten built in, but it hasn&rsquo;t been very
          well maintained in recent years. You can try it out, but your mileage
          may vary.
        </li>
        <li>
          <Link to="/#features">Kimochi</Link> is for you if you want a free,
          simple app with clean design and UX: you can easily capture, OCR,
          overlay, use any dictionary you like (Yomitan, Hachidori, 10ten), keep
          a reading log, and add and enhance your Anki cards. It also works well
          on a Steam Deck! ⭐
        </li>
      </ul>
      <p>
        Some of these projects move fast, so check their pages for the latest.
        <br />
        If you have more questions about Kimochi itself, see the{" "}
        <Link to="/faq">FAQ</Link>.
      </p>
      <p className="text-small">
        GameSentenceMiner, owocr and YomiNinja belong to their own authors and
        aren&rsquo;t affiliated with Kimochi.
      </p>
    </Prose>
  );
}

import { Link } from "react-router";
import { Prose } from "../components/Prose";
import {
  RESEARCHED,
  ROWS,
  SOURCES,
  TOOLS,
  type Cell,
} from "../content/compare";

function Unverified() {
  return (
    <span
      className="ml-1.5 inline-block rounded-sm border border-hairline px-1 align-[0.1em] text-meta whitespace-nowrap text-ink-3"
      title="Not confirmed from the tool's own documentation"
    >
      unverified
    </span>
  );
}

function CellText({ cell }: { cell: Cell }) {
  return (
    <>
      {cell.text}
      {cell.verified === false && <Unverified />}
    </>
  );
}

export function Compare() {
  return (
    <Prose
      title="How Kimochi compares"
      lede="Kimochi, Kamui, Game Sentence Miner and owocr all help you read Japanese games. They make different trade-offs, so pick the one that fits how you play."
      updated={RESEARCHED}
    >
      <p>
        This page tries to be fair. Each of these tools has real strengths, and
        several of them work well together. The facts below come from each
        project&rsquo;s own repository, site or documentation, linked under{" "}
        <a href="#sources">Sources</a>. Where we could not confirm something,
        the cell says so and carries an <Unverified /> tag. If anything here is
        wrong or out of date, please{" "}
        <a href="https://github.com/hamstu/kimochi-tauri/issues">
          open an issue
        </a>{" "}
        and we will fix it.
      </p>
      <p>
        A note on lineage: Kimochi owes a lot to{" "}
        <a href="https://github.com/AuroraWright/owocr">owocr</a> by Aurora
        Wright. Parts of Kimochi&rsquo;s approach to OCR were inspired by it,
        Kimochi can take owocr&rsquo;s output over WebSocket, and its Windows
        OneOCR support builds on Aurora Wright&rsquo;s{" "}
        <a href="https://github.com/AuroraWright/oneocr">oneocr</a> project.
        Game Sentence Miner also runs a fork of owocr.
      </p>

      <h2 id="table">At a glance</h2>
      {/* Wider than the 65ch column on large screens so four tools fit side by side. */}
      <div className="relative left-1/2 w-[min(72rem,calc(100vw-2rem))] -translate-x-1/2 sm:w-[min(72rem,calc(100vw-3rem))]">
        <table>
          <caption className="sr-only">
            Feature comparison of Kimochi, Kamui, Game Sentence Miner and owocr
          </caption>
          <thead>
            <tr>
              <th scope="col" className="min-w-[9rem]">
                <span className="sr-only">Feature</span>
              </th>
              {TOOLS.map((tool) => (
                <th key={tool.id} scope="col" className="min-w-[12rem]">
                  <a href={tool.url}>{tool.short}</a>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                {TOOLS.map((tool) => (
                  <td key={tool.id}>
                    <CellText cell={row.cells[tool.id]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-small">
        Checked on <time dateTime={RESEARCHED}>{RESEARCHED}</time>. These
        projects move quickly; check their own pages for the latest.
      </p>

      <h2 id="when">Which one fits</h2>

      <h3>Choose Game Sentence Miner if Anki mining is the point</h3>
      <p>
        GSM is built around making rich flashcards: it records the voiced line
        and trims it with voice detection, grabs screenshots or GIFs, and can
        add AI translations with your own key. It accepts text hooks from Agent,
        Textractor and LunaTranslator as well as OCR, has a wide choice of local
        and cloud engines, an overlay with Yomitan lookups, and an active,
        established community. It expects OBS Studio for capture, which is more
        setup, but it pays off if you already stream or record. If your goal is
        a deck full of sentence cards with audio, GSM does more of that than
        Kimochi does.
      </p>

      <h3>Choose owocr if you want a flexible OCR engine for your own setup</h3>
      <p>
        owocr is a focused, scriptable OCR tool: it watches the screen, a
        window, OBS, the clipboard or a folder, runs one of many engines, and
        sends the text to the clipboard, a WebSocket or a file. It does not try
        to be a reader or a flashcard tool, which makes it a good fit if you
        already have a texthooker page and Yomitan in the browser and just need
        reliable Japanese OCR feeding them. It also has the broadest engine list
        of the four.
      </p>

      <h3>Choose Kamui if you want a polished, hosted experience</h3>
      <p>
        Kamui is a commercial product with a web app and a Windows desktop app.
        Reviewers note quick setup with no API keys to arrange, cloud OCR with
        good accuracy on unusual fonts, a colour-coded sentence breakdown, AI
        translation and one-click Anki cards. It is a paid subscription, and its
        OCR runs in the cloud, so you trade cost and some privacy for
        convenience and support from a company.
      </p>

      <h3>Choose Kimochi if you want reading help in one desktop app</h3>
      <p>
        Kimochi puts capture, OCR, an overlay on the game, a running log,
        Yomitan, text to speech, Anki export and a per-session notebook of
        characters and places into one set of small windows, without OBS or a
        browser in the loop. It offers on-device engines (Apple Live Text,
        MeikiOCR, Manga OCR, OneOCR) as well as cloud OCR, and gamepad controls
        for the overlay. It is free and GPL-3.0 licensed, but it is young:
        builds are pre-release, Steam Deck support is early, and its Anki
        features are simpler than GSM&rsquo;s. See the{" "}
        <Link to="/#features">features</Link> or the{" "}
        <Link to="/privacy">privacy policy</Link> for what leaves your machine.
      </p>

      <h2 id="sources">Sources</h2>
      <ul>
        {SOURCES.map((source) => (
          <li key={source.url}>
            <a href={source.url}>{source.label}</a>
          </li>
        ))}
      </ul>
      <p className="text-small">
        Kamui, Game Sentence Miner and owocr are the work of their respective
        authors and are not affiliated with Kimochi.
      </p>
    </Prose>
  );
}

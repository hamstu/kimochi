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
      title="Kimochi and friends"
      lede="There are a few good tools for reading Japanese games. Here’s how they line up, so you can pick whatever suits you."
      updated={RESEARCHED}
    >
      <p>
        We tried to keep this fair. Everything below comes from each
        project&rsquo;s own docs (see <a href="#sources">Sources</a>), and
        anything we couldn&rsquo;t confirm is tagged <Unverified />. Spot
        something wrong?{" "}
        <a href="https://github.com/hamstu/kimochi-tauri/issues">
          Open an issue
        </a>{" "}
        and we&rsquo;ll fix it.
      </p>
      <p>
        Kimochi owes a lot to{" "}
        <a href="https://github.com/AuroraWright/owocr">owocr</a> by Aurora
        Wright. Some of its OCR ideas came from there, it can take owocr&rsquo;s
        output over WebSocket, and its Windows OneOCR support builds on{" "}
        <a href="https://github.com/AuroraWright/oneocr">oneocr</a>. GSM runs a
        fork of owocr too.
      </p>

      <h2 id="table">At a glance</h2>
      {/* Wider than the 65ch column on large screens so the tools fit side by side. */}
      <div className="relative left-1/2 w-[min(72rem,calc(100vw-2rem))] -translate-x-1/2 sm:w-[min(72rem,calc(100vw-3rem))]">
        <table>
          <caption className="sr-only">
            Feature comparison of Kimochi, Kamui, Game Sentence Miner, owocr and YomiNinja
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
        Checked <time dateTime={RESEARCHED}>{RESEARCHED}</time>. These
        projects move fast, so check their pages for the latest.
      </p>

      <h2 id="when">Which one?</h2>

      <h3>Game Sentence Miner, if you live in Anki</h3>
      <p>
        GSM is all about great flashcards: the voiced line trimmed to fit,
        screenshots or GIFs, AI translations with your own key. It takes text
        hooks as well as OCR, has loads of engines, an overlay with Yomitan,
        and a big, active community. It needs OBS, which is more setup, but if
        you want a deck full of sentence cards with audio, it does more of that
        than Kimochi.
      </p>

      <h3>owocr, if you like building your own setup</h3>
      <p>
        owocr just does OCR, and does it well. It watches the screen, a window,
        OBS, the clipboard or a folder, runs one of many engines, and sends the
        text wherever you want. Great if you already have a texthooker page and
        Yomitan in the browser. Biggest engine list of the lot.
      </p>

      <h3>YomiNinja, if you want a free overlay with Yomitan or 10ten</h3>
      <p>
        YomiNinja puts the text it reads over the screen, so you can hover it
        with Yomitan or 10ten, which come pre-installed. It runs on Windows,
        macOS and Linux, with PaddleOCR, Manga OCR and Apple Vision on your
        machine or Google Lens and Cloud Vision online. Auto OCR can watch a
        dialogue box, and a WebSocket feeds texthooker pages. It reads Chinese
        and Korean too. Anki integration is still on its planned list, and its
        latest release is from August 2025.
      </p>

      <h3>Kamui, if you want it all handled for you</h3>
      <p>
        Kamui is a paid app, on the web and Windows. Quick to set up, no API
        keys, solid cloud OCR, a colour-coded sentence breakdown, AI translation
        and one-click Anki cards. You pay a subscription and your captures go
        to the cloud, but there&rsquo;s a company behind it.
      </p>

      <h3>Kimochi, if you want it all in one app</h3>
      <p>
        Capture, OCR, the overlay, a log, Yomitan, Anki and a notebook, in a few
        small windows. No OBS, no browser tabs. Local engines or Google Lens,
        and a controller works too. It&rsquo;s free and open source, but
        it&rsquo;s young: Steam Deck support is early,
        and the Anki side is simpler than GSM&rsquo;s. More on the{" "}
        <Link to="/#features">home page</Link>, or see what leaves your machine
        in the <Link to="/privacy">privacy policy</Link>.
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
        Kamui, Game Sentence Miner, owocr and YomiNinja belong to their own
        authors and
        aren&rsquo;t affiliated with Kimochi.
      </p>
    </Prose>
  );
}

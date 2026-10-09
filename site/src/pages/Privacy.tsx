import { Link } from "react-router";
import { Prose } from "../components/Prose";

const ISSUES = "https://github.com/hamstu/kimochi-tauri/issues";

export function Privacy() {
  return (
    <Prose
      title="Privacy"
      lede="Kimochi is a desktop app with no accounts and no analytics. Most of what it does happens on your computer. This page lists exactly what leaves it, and when."
      updated="2026-10-09"
    >
      <h2 id="summary">The short version</h2>
      <ul>
        <li>There is no Kimochi account, sign-in or user database.</li>
        <li>
          The app has no analytics, telemetry, crash reporting or advertising.
          It does not report how you use it.
        </li>
        <li>
          Your captures, log, notebook, statistics and settings are stored on
          your computer and are not uploaded anywhere.
        </li>
        <li>
          Some features use the internet. When they do, they send only what that
          feature needs, and the on-device alternatives are listed below.
        </li>
      </ul>

      <h2 id="who">Who we are</h2>
      <p>
        Kimochi is made by Hamish Macpherson, an individual developer in Canada.
        &ldquo;We&rdquo; on this page means him. The app&rsquo;s source code is
        published on{" "}
        <a href="https://github.com/hamstu/kimochi-tauri">GitHub</a> under the
        GPL-3.0 licence, so you can check everything described here.
      </p>

      <h2 id="local">What stays on your computer</h2>
      <ul>
        <li>
          <strong>Screen and window captures.</strong> Frames are held in memory
          while Kimochi reads them and are not saved to disk or uploaded, except
          to a cloud OCR service if you use one (see below).
        </li>
        <li>
          <strong>Recognised text and the Log.</strong> OCR results, the line
          history, sessions and reading statistics are stored in the app&rsquo;s
          data folder.
        </li>
        <li>
          <strong>Notebook.</strong> Characters, places and notes you add stay
          in the app&rsquo;s data folder.
        </li>
        <li>
          <strong>Dictionaries.</strong> Yomitan dictionaries you import are
          stored locally, and lookups run locally.
        </li>
        <li>
          <strong>Settings</strong>, including any API keys you enter for
          optional services, are saved in the app&rsquo;s data folder (for
          example <code>~/Library/Application Support/dev.kimochi.app/</code> on
          macOS).
        </li>
      </ul>
      <p>
        Deleting the app&rsquo;s data folder removes all of this. We never
        receive a copy of it.
      </p>

      <h2 id="online">What leaves your computer, and when</h2>
      <p>
        These features contact a server. Each one only does so when you use it.
      </p>

      <h3>Kimochi cloud OCR</h3>
      <p>
        In current builds, cloud OCR is the default engine. When it is selected
        and you scan (manually or with Auto OCR), Kimochi sends an image of the
        captured region to our server at{" "}
        <code>kimochi-server.hamish.workers.dev</code>, hosted on Cloudflare
        Workers, which passes it to{" "}
        <a href="https://cloud.google.com/vision">Google Cloud Vision</a> for
        text recognition and returns the result. Our server does not store the
        images or the text. Cloudflare and Google process the request under
        their own terms; Google&rsquo;s policies describe how it handles images
        sent to Cloud Vision.
      </p>
      <p>
        If you would rather nothing leave your machine, choose an on-device
        engine in Settings &rarr; OCR &amp; Overlay: Apple Live Text (macOS),
        MeikiOCR, Manga OCR or OneOCR (Windows). These run entirely on your
        computer.
      </p>

      <h3>Your own OCR server or owocr</h3>
      <p>
        If you point Kimochi at a custom OCR endpoint or an owocr WebSocket
        service, captured images go to that address, which you control or chose.
        Its privacy depends on whoever runs it.
      </p>

      <h3>Text to speech</h3>
      <p>
        When you play audio for a line, Kimochi sends that line&rsquo;s text and
        the selected voice to our server, which asks{" "}
        <a href="https://elevenlabs.io/privacy-policy">ElevenLabs</a> to
        generate speech and returns the audio. Only the text you choose to hear
        is sent. Our server keeps at most the most recent clip in memory, to
        avoid generating it twice, and does not store it.
      </p>

      <h3>Model downloads</h3>
      <p>
        On-device OCR models are not bundled. The first time you select MeikiOCR
        or Manga OCR, Kimochi downloads the model files from Hugging Face (and
        its supporting files from GitHub). Those hosts see an ordinary download
        request from your IP address. Nothing about your captures is sent.
      </p>

      <h3>Dictionary downloads</h3>
      <p>
        If you download a recommended dictionary from inside Kimochi, the file
        comes from its publisher&rsquo;s host, for example Jitendex from GitHub
        or a frequency list from jiten.moe. Dictionaries you import from a file
        involve no network at all.
      </p>

      <h3>Anki</h3>
      <p>
        Kimochi talks to Anki through the AnkiConnect add-on on your own
        computer (by default <code>127.0.0.1:8765</code>). Cards go straight to
        your Anki collection. If you sync Anki with AnkiWeb, that is between you
        and Anki.
      </p>

      <h3>Other optional features</h3>
      <ul>
        <li>
          <strong>VNDB import</strong> in the Notebook sends your search terms
          to <a href="https://vndb.org">VNDB</a>&rsquo;s public API to find a
          title and its characters.
        </li>
        <li>
          <strong>DeepL translation</strong>, if you add your own DeepL API key,
          sends the line you translate to DeepL under your account.
        </li>
        <li>
          <strong>Explain</strong> runs an AI command-line tool you have
          installed and signed in to yourself (Codex or Claude Code). The
          sentence you ask about is sent to that provider under your own account
          and its terms.
        </li>
        <li>
          <strong>Yomitan API helper.</strong> If you install the optional
          native helper from settings, it is downloaded from GitHub.
        </li>
        <li>
          <strong>Clipboard and WebSocket</strong> inputs and outputs only talk
          to programs on your own computer (or addresses you enter).
        </li>
      </ul>
      <p>
        Your operating system, graphics drivers and any third-party OCR runtime
        may have their own data practices; those are outside Kimochi&rsquo;s
        control.
      </p>

      <h2 id="website">This website</h2>
      <p>
        This site is a set of static pages. It sets no cookies of its own and
        runs no analytics or advertising. It remembers your light or dark theme
        choice in your browser&rsquo;s local storage, which never leaves your
        device.
      </p>
      <p>
        To show the right download, the download button asks GitHub&rsquo;s
        public API for the latest release, directly from your browser. GitHub
        sees that request (including your IP address) under the{" "}
        <a href="https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement">
          GitHub Privacy Statement
        </a>
        . Downloads themselves come from GitHub Releases. The company hosting
        this site may keep standard server logs (such as IP address, page
        requested and browser) for security and operations; we do not use them
        to identify you.
      </p>

      <h2 id="children">Children</h2>
      <p>
        Kimochi is not directed at children and collects no personal information
        from anyone. If you are under the age at which you can consent to online
        services where you live, please use the optional online features with a
        parent or guardian&rsquo;s permission.
      </p>

      <h2 id="changes">Changes</h2>
      <p>
        If Kimochi starts sending anything new off your computer, this page will
        be updated before or alongside that release, and the date at the top
        will change. Significant changes will also be noted in the release
        notes. See also the <Link to="/terms">terms of use</Link>.
      </p>

      <h2 id="contact">Contact</h2>
      <p>
        Questions or concerns: open an issue on <a href={ISSUES}>GitHub</a>, or
        email {/* TODO(owner): replace with a real contact address. */}
        <strong>[contact email]</strong>.
      </p>
    </Prose>
  );
}

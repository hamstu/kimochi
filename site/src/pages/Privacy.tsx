import { Link } from "react-router";
import { Prose } from "../components/Prose";

const ISSUES = "https://github.com/hamstu/kimochi-tauri/issues";

export function Privacy() {
  return (
    <Prose
      title="Privacy"
      lede="Kimochi is a desktop app with no analytics, and accounts are optional. Most of what it does happens on your computer. This page lists exactly what leaves it, and when."
      updated="2026-10-16"
    >
      <h2 id="summary">The short version</h2>
      <ul>
        <li>
          A Kimochi account is optional. The app works fully without one. If
          you create one, we store what is listed under{" "}
          <a href="#accounts">Accounts</a>, and deleting the account removes it.
        </li>
        <li>
          The app has no analytics, telemetry, crash reporting or advertising.
          It does not report how you use it.
        </li>
        <li>
          Your captures, log, notebook, statistics and settings are stored on
          your computer. They are not uploaded anywhere unless you sign in and
          turn on backup.
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
          to an online OCR service (Google Lens or cloud OCR) if you use one
          (see below).
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

      <h3>Google Lens</h3>
      <p>
        Google Lens is the default engine for new installs. When it is selected
        and you scan (manually or with Auto OCR), Kimochi sends an image of the
        captured region straight from your computer to Google&rsquo;s Lens
        service at <code>lensfrontend-pa.googleapis.com</code> (the one Chrome
        uses for Google Lens) and receives the recognised text. The image does
        not pass through our servers, and we never see it. Google processes it
        under its own terms and{" "}
        <a href="https://policies.google.com/privacy">privacy policy</a>,
        which describe what it keeps.
      </p>

      <h3>Kimochi cloud OCR</h3>
      <p>
        Kimochi&rsquo;s own cloud OCR is available when you are signed in to a
        Kimochi account (see <a href="#accounts">Accounts</a>). When it is
        selected, each scan (manual or with Auto OCR) sends an
        image of the captured region to our server at{" "}
        <code>kimochi-server.hamish.workers.dev</code>, hosted on Cloudflare
        Workers, which passes it to{" "}
        <a href="https://cloud.google.com/vision">Google Cloud Vision</a> for
        text recognition and returns the result. Our server does not store the
        images or the text; it only adds one to your monthly count. Cloudflare and Google process the request under
        their own terms; Google&rsquo;s policies describe how it handles images
        sent to Cloud Vision.
      </p>
      <p>
        If you would rather nothing leave your machine, choose an on-device
        engine in Settings &rarr; OCR &amp; Overlay: Apple Live Text (macOS),
        MeikiOCR, Manga OCR or OneOCR (Windows). These run entirely on your
        computer.
      </p>

      <h3>Your own OCR server</h3>
      <p>
        If you point Kimochi at a custom OCR endpoint, captured images go to
        that address, which you control or chose.
        Its privacy depends on whoever runs it.
      </p>

      <h3>Text to speech</h3>
      <p>
        Read aloud is likewise available when you are signed in. When you play
        audio for a line, Kimochi sends that line&rsquo;s text and the selected
        voice to our server, which asks{" "}
        <a href="https://elevenlabs.io/privacy-policy">ElevenLabs</a> to
        generate speech and returns the audio. Only the text you choose to hear
        is sent. The generated audio is cached (in Cloudflare R2, named by a
        fingerprint of the voice and text, not by who asked) so the same line
        is not generated twice for anyone.
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
          <strong>Kimochi translation and explanations</strong>, when you are
          signed in and choose them, send the line (and, for explanations, the
          surrounding context the app includes in its prompt) to our server,
          which passes it to DeepL or to an AI model provider (Anthropic or
          OpenAI) through Cloudflare AI Gateway. The gateway keeps request logs,
          tagged with your account id, which we use to run the service and
          watch costs. Our server does not otherwise store the text.
        </li>
        <li>
          <strong>Explain</strong> with your own tool runs an AI command-line tool you have
          installed and signed in to yourself (Codex or Claude Code). The
          sentence you ask about is sent to that provider under your own account
          and its terms.
        </li>
        <li>
          <strong>Yomitan API helper.</strong> If you choose the Yomitan API
          dictionary option and install its optional native helper, the helper
          is downloaded from GitHub. Lookups then go to the Yomitan in your own
          browser, on your computer.
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

      <h2 id="accounts">Accounts</h2>
      <p>
        You can use Kimochi without an account. An account adds Kimochi&rsquo;s
        hosted services (cloud OCR, read aloud, translation and explanations,
        within free monthly allowances) and, if you turn it on, backup of your
        preferences and sessions. If you create one, we store:
      </p>
      <ul>
        <li>
          <strong>Who you are:</strong> your email address, the display name
          you choose, and either a hashed password (we never see or keep the
          password itself) or the id of the Google or Discord account you
          connect, plus the name and email it shares.
        </li>
        <li>
          <strong>Sign-ins:</strong> the browsers and Kimochi apps signed in to
          your account, with their device name, platform and when they were
          last used, so you can sign them out.
        </li>
        <li>
          <strong>Usage counts:</strong> how many scans, read-alouds,
          translations and explanations you used each month, to apply the
          allowances. Not the images or text themselves.
        </li>
        <li>
          <strong>Backup, only if you turn it on:</strong> your preferences, and
          your sessions with their lines, notebook and captured images.
        </li>
      </ul>
      <p>
        This is kept on Cloudflare: account data in Cloudflare D1, backed-up
        files in Cloudflare R2. Emails we send (confirming your address,
        resetting a password) go through an email delivery service. We do not
        sell or share account data, or use it for advertising.
      </p>
      <p>
        You can delete your backups, or your whole account, from the{" "}
        <Link to="/account">account page</Link> at any time. Deleting the
        account removes everything listed above straight away, including
        every backed-up file, and signs out every linked app.
      </p>

      <h2 id="website">This website</h2>
      <p>
        This site is a set of static pages plus the account pages. It runs no
        analytics or advertising. If you sign in, it sets one cookie that keeps
        you signed in (for up to 30 days of inactivity), and a short-lived one
        while you sign in with Google or Discord; otherwise it sets none. It remembers your light or dark theme
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
        unless you create an account. If you are under the age at which you can consent to online
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

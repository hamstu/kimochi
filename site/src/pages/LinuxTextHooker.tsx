import { Link } from 'react-router'
import { Prose } from '../components/Prose'
import { FaqAnswer } from '../components/FaqAnswer'
import { LINUX_HOOKER_FAQ } from '../content/linuxHooker.js'
import { LINUX_HOOKER_PATH } from '../lib/seo.js'
import { docsUrl } from '../lib/docs.js'

/**
 * /linux-steam-deck-text-hooker: text hooking Windows games through Proton or Wine, written for
 * people searching for a Textractor alternative on Linux or a hooker for the Steam Deck. Every
 * claim here must match https://docs.kimochiapp.com/reading/text-hooker/ (or a released
 * CHANGELOG entry); the FAQ at the bottom is also the page's FAQPage JSON-LD.
 */
export function LinuxTextHooker() {
  return (
    <Prose
      title="Text hooking on Linux and Steam Deck"
      lede="Textractor and LunaTranslator are Windows-only programs, so on Linux you normally have to run them inside the game’s own Wine or Proton prefix yourself. Kimochi runs them for you. 💪"
      page={LINUX_HOOKER_PATH}
    >
      <p>
        Kimochi is a free, open-source app for reading games in Japanese (and other languages!). Text hooking means
        using another program to read a game&rsquo;s text from inside the game instead of off the screen.{' '}
        <Link to="/download/linux">Install Kimochi on Linux or Steam Deck</Link>.
      </p>

      <h2 id="how-it-works">How it works</h2>
      <ul>
        <li>
          Kimochi runs LunaHook with the game&rsquo;s own Proton or Wine, inside the game&rsquo;s prefix. Neither hooker
          comes with Kimochi: the first time you hook a game, it downloads LunaHook (about 6&nbsp;MB).
        </li>
        <li>
          It hooks Windows games run through Steam (Proton) or a Wine launcher such as Lutris, Bottles or Heroic. Since
          Kimochi 1.0.0, games run through Flatpak apps can be hooked too.
        </li>
        <li>
          A hooked game sends several streams of text, called threads: the dialogue, the speaker&rsquo;s name, menus.
          The first time, Kimochi picks the dialogue by reading the game&rsquo;s window with a local OCR engine and
          matching each thread against what&rsquo;s on screen. Pick another thread if it got it wrong; your choice is
          remembered for the game.
        </li>
        <li>
          Each line lands in the Log and, with the overlay on, in a card over the game&rsquo;s own text, where you can
          look its words up.
        </li>
      </ul>
      <p>
        Start the game, choose its window in Kimochi&rsquo;s sidebar, and turn on <strong>Text hooking</strong> under
        its card. The switch is kept for each game, so next time it hooks straight away. The full guide is{' '}
        <a href={docsUrl('/reading/text-hooker/')}>Text hooking in the docs</a>.
      </p>

      <h2 id="steam-deck">On the Steam Deck, in Gaming Mode</h2>
      <ol>
        <li>
          Install Kimochi once from Desktop Mode (<Link to="/download/linux#steam-deck">Steam Deck install</Link>, or{' '}
          <a href={docsUrl('/install/steam-deck/')}>step by step in the docs</a>
          ), and let it add itself to your Steam library.
        </li>
        <li>
          In Gaming Mode, start Kimochi from your library, then your game. Choose the game in Kimochi&rsquo;s{' '}
          <strong>Source</strong> tab.
        </li>
        <li>
          Back in the game, press <strong>R4</strong> (the upper right back button) for Kimochi&rsquo;s controller menu.
          While you&rsquo;re hooking a game it starts on <strong>Read along</strong>: step through the line&rsquo;s
          words with the D-pad, and each one&rsquo;s dictionary entry opens. Its <strong>Text Hooker</strong> item has
          the card&rsquo;s settings.
        </li>
      </ol>
      <p>
        See <a href={docsUrl('/controller/gaming-mode/')}>Gaming Mode</a> in the docs.
      </p>

      <h2 id="audio-hooking">Sentence audio from the game itself (Audio hooking)</h2>
      <p>
        With Text hooking on, <strong>Audio hooking</strong> takes each line&rsquo;s voice straight from the game for
        its <a href={docsUrl('/lookups/anki/#sentence-audio')}>Anki sentence audio</a>, without the music or sound
        effects. When a line&rsquo;s voice can&rsquo;t be taken from the game, Kimochi records it from your speakers
        instead.
      </p>

      <h2 id="limits">What can&rsquo;t be hooked</h2>
      <p>Only Windows games can be hooked. These can&rsquo;t:</p>
      <ul>
        <li>
          <strong>Native Linux games.</strong> If a game also has a Windows version on Steam, you can run that instead:
          the game&rsquo;s{' '}
          <strong>Properties → Compatibility → Force the use of a specific Steam Play compatibility tool</strong>.
        </li>
        <li>
          <strong>Linux on ARM64 computers.</strong>
        </li>
        <li>
          <strong>Games built for ARM64</strong> (a game must be a 32- or 64-bit x86 program), and apps that are
          protected or running as administrator.
        </li>
        <li>
          <strong>macOS</strong>, which has no Text hooking.
        </li>
      </ul>
      <p>
        For those, read the game <a href={docsUrl('/reading/sources/')}>with OCR</a>, or feed Kimochi from a texthooker
        you run yourself, over WebSocket or the clipboard.
      </p>

      <h2 id="other-hookers">Already use Textractor, LunaTranslator or Agent?</h2>
      <p>
        Kimochi stands on their shoulders. Its hooker is LunaHook, from{' '}
        <a href="https://github.com/HIllya51/LunaTranslator">LunaTranslator</a>, and{' '}
        <a href="https://github.com/Artikash/Textractor">Textractor</a> is its fallback. What Kimochi adds is running
        them in the right prefix for you, picking the dialogue, and putting the lines over the game.
      </p>
      <p>
        If you&rsquo;d rather keep your own hooker, such as Textractor, LunaTranslator or{' '}
        <a href="https://github.com/0xDC00/agent">Agent</a>, point Kimochi at it over WebSocket (any texthooker that
        sends its text over a WebSocket works), or have it copy each line to the clipboard. See{' '}
        <a href={docsUrl('/reading/texthookers/')}>Texthookers and clipboard</a>. And if you want a different workflow
        altogether, <a href="https://github.com/bpwhelan/GameSentenceMiner">GameSentenceMiner</a> has its own text
        hooking and advanced Anki card enrichment; the <Link to="/compare">comparison</Link> has more.
      </p>

      <h2 id="faq">Questions</h2>
      {LINUX_HOOKER_FAQ.map((item) => (
        <section key={item.id} id={item.id} aria-labelledby={`${item.id}-q`}>
          <h3 id={`${item.id}-q`}>{item.q}</h3>
          <FaqAnswer item={item} />
        </section>
      ))}
      <p>
        More answers about Kimochi in the <Link to="/faq">FAQ</Link>.
      </p>

      <p className="text-small">
        Textractor, LunaTranslator, LunaHook, Agent and GameSentenceMiner belong to their own authors and aren&rsquo;t
        affiliated with Kimochi.
      </p>
    </Prose>
  )
}

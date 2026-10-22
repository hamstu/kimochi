import { Link } from "react-router";
import { Prose } from "../components/Prose";

export function Terms() {
  return (
    <Prose
      title="Terms of use"
      lede="Kimochi is free software made by one person. These terms are short and meant to be read."
      updated="2026-10-21"
    >
      <h2 id="agreement">1. These terms</h2>
      <p>
        These terms cover your use of the Kimochi desktop app and this website.
        By downloading or using Kimochi you agree to them. If you do not agree,
        please do not use it. Kimochi is made by Hamish Macpherson
        (&ldquo;we&rdquo;, &ldquo;us&rdquo;).
      </p>

      <h2 id="licence">2. Your licence to use Kimochi</h2>
      <p>
        Kimochi is free. You may download it, install it on any number of your
        own devices and use it for personal or commercial purposes. Its source
        code is published under the{" "}
        <a href="https://www.gnu.org/licenses/gpl-3.0.html">
          GNU General Public License, version 3
        </a>{" "}
        (GPL-3.0). The GPL governs copying, modifying and redistributing the
        software, and nothing in these terms limits the rights it gives you.
        Some bundled components, such as OCR models and dictionaries, have their
        own licences, which ship with the app.
      </p>

      <h2 id="as-is">3. Provided as is</h2>
      <p>
        Kimochi is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;,
        without warranty of any kind, express or implied, including
        merchantability, fitness for a particular purpose and non-infringement.
        OCR, dictionary results, translations and speech can be wrong. We do not
        promise that Kimochi will work with every game, be error-free, or stay
        available, and features may change or be removed. Online features
        such as Google Lens depend on services we do not control and may stop
        working, change or be discontinued at any time.
      </p>

      <h2 id="liability">4. Limitation of liability</h2>
      <p>
        To the fullest extent the law allows, we are not liable for any
        indirect, incidental, special, consequential or punitive damages, or for
        lost data, profits or time, arising from your use of Kimochi or this
        website, even if we were told such damage was possible. Our total
        liability for any claim is limited to the amount you paid for Kimochi
        (nothing), or the lowest amount your local law permits. Some places do
        not allow these limits, so they may not all apply to you.
      </p>

      <h2 id="your-content">5. What you capture and connect</h2>
      <ul>
        <li>
          You are responsible for the games, visual novels and other content you
          capture, and for using Kimochi in line with their licences and terms.
          Kimochi reads what is on your screen; it does not give you any rights
          to that content.
        </li>
        <li>
          Do not use Kimochi to copy and redistribute other people&rsquo;s work
          in ways the law or its owner does not allow.
        </li>
        <li>
          If you use third-party services (Google Lens, a cloud OCR provider,
          AnkiConnect, DeepL, an AI tool, dictionary sources or others), you are
          responsible for following their terms, and for any keys or accounts
          you use with them.
        </li>
      </ul>

      <h2 id="trademarks">6. Trademarks</h2>
      <p>
        Names and images of games, visual novels, companies and services
        mentioned on this site or in the app belong to their owners. Their
        appearance does not mean they endorse or are affiliated with Kimochi.
      </p>

      <h2 id="privacy">7. Privacy</h2>
      <p>
        How Kimochi handles data is described in the{" "}
        <Link to="/privacy">privacy policy</Link>.
      </p>

      <h2 id="law">8. Governing law</h2>
      <p>
        These terms are governed by the laws of the Province of British
        Columbia and the federal laws of Canada applicable therein, without
        regard to conflict-of-law rules. The courts of British Columbia have
        jurisdiction over any dispute about these terms. Nothing here removes
        rights you have under the consumer protection laws of the place where
        you live, including any right to bring a claim there.
      </p>

      <h2 id="changes">9. Changes</h2>
      <p>
        We may update these terms. The date at the top shows the latest version,
        and continuing to use Kimochi after a change means you accept the
        updated terms. If a part of these terms is found unenforceable, the rest
        still applies.
      </p>

      <h2 id="contact">10. Contact</h2>
      <p>
        Questions about these terms: email{" "}
        <a href="mailto:hamstu@gmail.com">hamstu@gmail.com</a>, or open an
        issue on{" "}
        <a href="https://github.com/hamstu/kimochi-tauri/issues">GitHub</a>.
      </p>
    </Prose>
  );
}

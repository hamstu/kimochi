import { Link } from 'react-router'
import { Prose } from '../components/Prose'
import { FaqAnswer } from '../components/FaqAnswer'
import { FAQ } from '../content/faq.js'

/** /faq: every question in src/content/faq.js. Its FAQPage JSON-LD comes from the same file. */
export function Faq() {
  return (
    <Prose
      title="Frequently asked questions"
      lede="What Kimochi is, who it’s for, what it costs, and what leaves your computer."
    >
      <nav aria-label="Questions">
        <ul>
          {FAQ.map((item) => (
            <li key={item.id}>
              <a href={`#${item.id}`}>{item.q}</a>
            </li>
          ))}
        </ul>
      </nav>
      {FAQ.map((item) => (
        <section key={item.id} aria-labelledby={item.id}>
          <h2 id={item.id} className="scroll-mt-24">
            {item.q}
          </h2>
          <div className="mt-[0.6em] flex flex-col gap-[1.1em]">
            <FaqAnswer item={item} />
          </div>
        </section>
      ))}
      <p>
        Didn’t find your answer? The <Link to="/compare">comparison</Link> and the{' '}
        <Link to="/privacy">privacy policy</Link> go into more detail.
      </p>
    </Prose>
  )
}

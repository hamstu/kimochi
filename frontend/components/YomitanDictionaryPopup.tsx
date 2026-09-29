/**
 * COPY of `src/renderer/src/components/YomitanDictionaryPopup.tsx`.
 * Deltas: `window.yomitan.termEntries` -> the bridge's `termEntries` (same request, HTTP through the
 * Tauri plugin instead of Electron IPC); Radix Themes layout/text/badge/spinner -> kit components
 * and `YomitanDictionaryPopup.css` (same structure and content, kit type scale and colour roles).
 *
 * Not mounted by any window today (the reader popup renders `TermDefinition` instead); kept so the
 * Electron copy stays diffable.
 *
 * The response types below are the original's and model Yomitan's loosely-typed structured content,
 * so they keep their `any`s rather than being re-typed here and drifting from the Electron build.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, type JSX } from 'react'
import { termEntries } from '../bridge/yomitan'
import { Badge, Spinner } from '@kit'
import './YomitanDictionaryPopup.css'

interface YomitanDictionaryPopupProps {
  word: string
  apiUrl: string
}

interface StructuredContentItem {
  tag?: string
  content?: any
  style?: Record<string, string>
  data?: Record<string, any>
  lang?: string
  title?: string
}

interface DictionaryDefinition {
  dictionary: string
  entries: any[]
  tags?: Array<{
    name: string
    content: string[]
    category: string
  }>
}

interface DictionaryEntry {
  inflectionRuleChainCandidates?: Array<{
    inflectionRules?: Array<{ name: string }>
  }>
  definitions: DictionaryDefinition[]
  headwords: Array<{
    term: string
    reading: string
  }>
}

interface TermEntriesResponse {
  dictionaryEntries: DictionaryEntry[]
}

function renderStructuredContent(content: any, depth = 0): JSX.Element | JSX.Element[] | string {
  // Base case: if it's a string, return it
  if (typeof content === 'string') {
    return content
  }

  // If it's an array, map over it
  if (Array.isArray(content)) {
    return (
      <>
        {content.map((item, i) => (
          <span key={i}>{renderStructuredContent(item, depth + 1)}</span>
        ))}
      </>
    )
  }

  // If it's an object with structured content
  if (content && typeof content === 'object') {
    const item = content as StructuredContentItem
    const Tag = (item.tag || 'div') as keyof JSX.IntrinsicElements

    // Handle special cases
    if (item.tag === 'ruby') {
      const contentArray = Array.isArray(item.content) ? item.content : [item.content]
      const baseText = contentArray.filter((c) => typeof c === 'string').join('')
      const rtElement = contentArray.find((c) => c?.tag === 'rt')
      const rtText = rtElement?.content?.content || rtElement?.content

      return (
        <ruby style={item.style}>
          {baseText}
          <rt>{rtText}</rt>
        </ruby>
      )
    }

    // Handle spans with data attributes (like example keywords)
    if (item.tag === 'span' && item.data?.content === 'example-keyword') {
      return (
        <span
          style={{
            ...item.style,
            fontWeight: 'bold',
            color: 'var(--k-accent-text)'
          }}
        >
          {renderStructuredContent(item.content, depth + 1)}
        </span>
      )
    }

    // Handle lists
    if (item.tag === 'ul' || item.tag === 'ol') {
      // Check if this is a glossary list
      if (item.data?.content === 'glossary') {
        return (
          <ul
            style={{
              margin: '0.25em 0',
              paddingLeft: '1.5em',
              listStyleType: 'disc',
              ...item.style
            }}
          >
            {renderStructuredContent(item.content, depth + 1)}
          </ul>
        )
      }

      // Check if this is an example sentence
      if (item.style?.listStyleType === 'none') {
        return (
          <div className="ydp-examples" style={item.style}>
            {renderStructuredContent(item.content, depth + 1)}
          </div>
        )
      }

      return (
        <Tag style={{ margin: '0.5em 0', ...item.style }}>
          {renderStructuredContent(item.content, depth + 1)}
        </Tag>
      )
    }

    // Handle list items
    if (item.tag === 'li') {
      // Check if this is an example sentence (has special styling)
      if (item.data?.content === 'example-sentence-a') {
        return (
          <div key={depth} className="ydp-example-a" style={item.style}>
            {renderStructuredContent(item.content, depth + 1)}
          </div>
        )
      }

      if (item.data?.content === 'example-sentence-b') {
        return (
          <div key={depth} className="ydp-example-b" style={item.style}>
            {renderStructuredContent(item.content, depth + 1)}
          </div>
        )
      }

      return (
        <li key={depth} style={item.style}>
          {renderStructuredContent(item.content, depth + 1)}
        </li>
      )
    }

    // Default case: render with the tag and style
    if (item.tag) {
      return (
        <Tag style={item.style} title={item.title}>
          {item.content && renderStructuredContent(item.content, depth + 1)}
        </Tag>
      )
    }

    // If no tag, just try to render content
    if (item.content) {
      return <>{renderStructuredContent(item.content, depth + 1)}</>
    }
  }

  return ''
}

export default function YomitanDictionaryPopup({
  word,
  apiUrl
}: YomitanDictionaryPopupProps): JSX.Element {
  const [data, setData] = useState<TermEntriesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const fetchDefinition = async (): Promise<void> => {
      if (!word || !apiUrl) return

      setLoading(true)
      setError(null)

      try {
        const result = (await termEntries(word, apiUrl)) as TermEntriesResponse

        if (!cancelled) {
          setData(result)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to fetch definition')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    fetchDefinition()

    return () => {
      cancelled = true
    }
  }, [word, apiUrl])

  if (loading) {
    return (
      <div className="ydp-state" role="status">
        <Spinner label="Loading definition" />
        <span>Loading definition…</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="ydp-state ydp-state-error" role="alert">
        Error: {error}
      </div>
    )
  }

  if (!data || !data.dictionaryEntries || data.dictionaryEntries.length === 0) {
    return <div className="ydp-state">No definition found</div>
  }

  return (
    <div className="ydp">
      {data.dictionaryEntries.map((entry, entryIdx) => {
        const headword = entry.headwords?.[0]
        const rules = entry.inflectionRuleChainCandidates?.[0]?.inflectionRules ?? []

        return (
          <section key={entryIdx} className="ydp-entry">
            {/* Headword section */}
            {headword && (
              <header className="ydp-headword" lang="ja">
                <span className="ydp-term">{headword.term}</span>
                {headword.reading && <span className="ydp-reading">{headword.reading}</span>}
                {rules.length > 0 && (
                  <span className="ydp-rules">{rules.map((rule) => rule.name).join(' ')}</span>
                )}
              </header>
            )}

            {/* Definitions */}
            {entry.definitions.map((def, defIndex) => (
              <div key={defIndex} className="ydp-definition">
                {/* Dictionary name and tags */}
                <div className="ydp-badges">
                  <Badge tone="accent">{def.dictionary}</Badge>
                  {def.tags?.slice(0, 3).map(
                    (tag, tagIndex) =>
                      tag.category === 'partOfSpeech' && (
                        <Badge key={tagIndex} title={tag.content.join(', ')}>
                          {tag.name}
                        </Badge>
                      )
                  )}
                </div>

                {/* Dictionary entries */}
                {def.entries.map((entry, entryIndex) => (
                  <div key={entryIndex} className="ydp-gloss">
                    {typeof entry === 'string' ? (
                      entry
                    ) : entry.type === 'structured-content' ? (
                      Array.isArray(entry.content) ? (
                        entry.content.map((item: unknown, i: number) => (
                          <div key={i} className="ydp-sc">
                            {renderStructuredContent(item)}
                          </div>
                        ))
                      ) : (
                        renderStructuredContent(entry.content)
                      )
                    ) : (
                      JSON.stringify(entry)
                    )}
                  </div>
                ))}
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}

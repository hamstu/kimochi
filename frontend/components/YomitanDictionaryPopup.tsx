/**
 * COPY of `src/renderer/src/components/YomitanDictionaryPopup.tsx`.
 * Delta: `window.yomitan.termEntries` -> the bridge's `termEntries` (same request, HTTP through the
 * Tauri plugin instead of Electron IPC). Rendering is unchanged.
 *
 * The response types below are the original's and model Yomitan's loosely-typed structured content,
 * so they keep their `any`s rather than being re-typed here and drifting from the Electron build.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, type JSX } from 'react'
import { termEntries } from '../bridge/yomitan'
import { Box, Text, Badge, Spinner } from '@radix-ui/themes'

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
            color: 'var(--accent-11)'
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
          <Box my="2" style={item.style}>
            {renderStructuredContent(item.content, depth + 1)}
          </Box>
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
          <Box
            key={depth}
            style={{
              fontSize: '115%',
              padding: '0.25em 0.5em',
              borderLeft: '3px solid var(--accent-9)',
              marginTop: '0.5em',
              ...item.style
            }}
          >
            {renderStructuredContent(item.content, depth + 1)}
          </Box>
        )
      }

      if (item.data?.content === 'example-sentence-b') {
        return (
          <Box
            key={depth}
            style={{
              fontSize: '85%',
              padding: '0.25em 0.5em',
              borderLeft: '3px solid var(--gray-6)',
              color: 'var(--gray-11)',
              marginBottom: '0.5em',
              ...item.style
            }}
          >
            {renderStructuredContent(item.content, depth + 1)}
          </Box>
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
      <Box p="4" style={{ minWidth: '300px', textAlign: 'center' }}>
        <Spinner />
        <Text size="2" color="gray" mt="2">
          Loading definition...
        </Text>
      </Box>
    )
  }

  if (error) {
    return (
      <Box p="4" style={{ minWidth: '300px' }}>
        <Text size="2" color="red">
          Error: {error}
        </Text>
      </Box>
    )
  }

  if (!data || !data.dictionaryEntries || data.dictionaryEntries.length === 0) {
    return (
      <Box p="4" style={{ minWidth: '300px' }}>
        <Text size="2" color="gray">
          No definition found
        </Text>
      </Box>
    )
  }

  return (
    <Box
      p="3"
      style={{
        maxWidth: '600px',
        maxHeight: '280px',
        overflow: 'auto',
        fontSize: '14px',
        lineHeight: '1.6'
      }}
    >
      {data.dictionaryEntries.map((entry, entryIdx) => {
        const headword = entry.headwords?.[0]

        return (
          <Box key={entryIdx} mb="4">
            {/* Headword section */}
            {headword && (
              <Box mb="3" pb="2" style={{ borderBottom: '1px solid var(--gray-6)' }}>
                <Text size="5" weight="bold" style={{ fontSize: '24px' }}>
                  {headword.term}
                </Text>
                {headword.reading && (
                  <Text size="3" color="gray" ml="2">
                    【{headword.reading}】
                  </Text>
                )}
                {entry.inflectionRuleChainCandidates &&
                  entry.inflectionRuleChainCandidates.length > 0 &&
                  entry.inflectionRuleChainCandidates[0].inflectionRules &&
                  entry.inflectionRuleChainCandidates[0].inflectionRules.length > 0 && (
                    <Text size="2" color="gray" ml="2" style={{ opacity: 0.6 }}>
                      {entry.inflectionRuleChainCandidates[0].inflectionRules
                        .map((rule) => rule.name)
                        .join(' ')}
                    </Text>
                  )}
              </Box>
            )}

            {/* Definitions */}
            {entry.definitions.map((def, defIndex) => (
              <Box key={defIndex} mb="4">
                {/* Dictionary name and tags */}
                <Box mb="2">
                  <Badge color="blue" size="1" style={{ fontSize: '11px' }}>
                    {def.dictionary}
                  </Badge>
                  {def.tags?.slice(0, 3).map(
                    (tag, tagIndex) =>
                      tag.category === 'partOfSpeech' && (
                        <Badge
                          key={tagIndex}
                          color="gray"
                          variant="soft"
                          size="1"
                          ml="1"
                          style={{ fontSize: '11px' }}
                          title={tag.content.join(', ')}
                        >
                          {tag.name}
                        </Badge>
                      )
                  )}
                </Box>

                {/* Dictionary entries */}
                {def.entries.map((entry, entryIndex) => (
                  <Box key={entryIndex} mb="2">
                    {typeof entry === 'string' ? (
                      <Text size="2">{entry}</Text>
                    ) : entry.type === 'structured-content' ? (
                      <Box style={{ fontSize: '13px' }}>
                        {Array.isArray(entry.content)
                          ? entry.content.map((item: unknown, i: number) => (
                              <Box key={i} mb="1">
                                {renderStructuredContent(item)}
                              </Box>
                            ))
                          : renderStructuredContent(entry.content)}
                      </Box>
                    ) : (
                      <Text size="2">{JSON.stringify(entry)}</Text>
                    )}
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}

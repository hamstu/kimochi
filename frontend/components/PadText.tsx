/**
 * Text that may name controller buttons ("L1 + ✕"), with the PlayStation face symbols drawn
 * (ui/pad-layout.js PAD_SYMBOLS) instead of typed, so the four look alike in size and weight.
 */
import { createElement, type CSSProperties, type ReactNode } from 'react'
import { PAD_RUN_STYLE, PAD_SYMBOLS, PAD_SYMBOL_SPLIT, PAD_SYMBOL_SVG } from '../../ui/pad-layout.js'

/** SVG attribute names as React spells them (`stroke-width` → `strokeWidth`). */
function reactProps(values: Record<string, string | number>): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => [name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), value])
  )
}

const SVG_PROPS = reactProps(PAD_SYMBOL_SVG)

/** ui/pad-layout.js PAD_RUN_STYLE, as React takes a style. */
const RUN_STYLE = Object.fromEntries(
  PAD_RUN_STYLE.split(';').map((rule) => {
    const [name, value] = rule.split(':')
    return [name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()), value]
  })
) as CSSProperties

export function PadText({ text }: { text: string }): ReactNode {
  const parts = String(text).split(PAD_SYMBOL_SPLIT).filter(Boolean)
  if (parts.length === 1 && !PAD_SYMBOLS[parts[0]]) return text
  // A run of its own that centres the symbols on the text, not on its baseline, inside a flex
  // key or a line of text alike, its spaces kept ("L1 + ✕").
  return (
    <span style={RUN_STYLE}>
      {parts.map((part, index) => {
        const symbol = PAD_SYMBOLS[part]
        if (!symbol) return part
        return (
          <svg
            key={index}
            className="pad-symbol"
            role="img"
            aria-label={symbol.label}
            width="1.2em"
            height="1.2em"
            style={{ display: 'block', flex: 'none' }}
            {...SVG_PROPS}
          >
            {symbol.shapes.map(([tag, values], shape) => createElement(tag, { key: shape, ...reactProps(values) }))}
          </svg>
        )
      })}
    </span>
  )
}

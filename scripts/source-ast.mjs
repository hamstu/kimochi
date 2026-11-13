// Parses JavaScript and TypeScript for the tests that read the app's own source (which native
// commands the UI calls, which overlay functions run in a sandbox). oxc's parser returns an
// ESTree tree whose nodes carry `start`/`end` offsets into the source.
import { parseSync } from 'oxc-parser'

/** The program of `source`, parsed by its file name's extension. Throws on a syntax error. */
export function parse(filename, source) {
  const { program, errors } = parseSync(filename, source)
  if (errors.length) throw new Error(`${filename}: ${errors[0].message}`)
  return program
}

/** Calls `visit` with every node under `node`, depth first. */
export function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue
    if (Array.isArray(value)) for (const child of value) walk(child, visit)
    else if (value && typeof value === 'object') walk(value, visit)
  }
}

/** The program's top-level function declarations by name (exported ones included). */
export function topLevelFunctions(program) {
  const functions = new Map()
  for (const statement of program.body) {
    const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    if (node?.type === 'FunctionDeclaration' && node.id) functions.set(node.id.name, node)
  }
  return functions
}

/** A string literal's value, or undefined for any other node. */
export function stringValue(node) {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined
}

/** The source text a node spans. */
export const text = (source, node) => source.slice(node.start, node.end)

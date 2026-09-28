import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const commandCalls = new Set(['invoke', 'optional'])
async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const filename = path.join(directory, entry.name)
      if (entry.isDirectory()) return sources(filename)
      return /\.(?:tsx?|js)$/.test(filename) && !filename.endsWith('.d.ts') ? [filename] : []
    })
  )
  return nested.flat()
}

test('frontend literal native commands have registered Rust handlers', async () => {
  const main = await readFile(path.join(root, 'src-tauri/src/main.rs'), 'utf8')
  const handlers = [...main.matchAll(/generate_handler!\s*\[([\s\S]*?)\]/g)].flatMap((match) =>
    match[1].split(',').map((name) => name.trim().split('::').at(-1))
  )
  assert.ok(handlers.length > 0, 'No native command registration found')
  const registered = new Set(handlers)
  const files = (
    await Promise.all(['frontend', 'ui', 'host'].map((folder) => sources(path.join(root, folder))))
  ).flat()
  const missing = new Set()
  for (const file of files) {
    const source = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        // The overlay's optional() wrapper must resolve too: a swallowed missing
        // handler would otherwise look like a working feature with no result.
        const invokes = ts.isIdentifier(callee)
          ? commandCalls.has(callee.text)
          : ts.isPropertyAccessExpression(callee) && commandCalls.has(callee.name.text)
        const command = node.arguments[0]
        if (
          invokes &&
          command &&
          ts.isStringLiteral(command) &&
          !command.text.startsWith('plugin:') &&
          !registered.has(command.text)
        ) {
          missing.add(`${path.relative(root, file)}: ${command.text}`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.deepEqual([...missing].sort(), [], 'UI calls must resolve to registered native commands')
})

test('controller action names are accepted by the native dispatcher', async () => {
  const native = await readFile(path.join(root, 'src-tauri/src/actions.rs'), 'utf8')
  const block = native.match(/pub const ACTIONS[^=]*=\s*&\[([\s\S]*?)\];/)
  assert.ok(block, 'Native action allow-list is missing')
  const accepted = new Set([...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]))
  const missing = new Set()
  const literals = (node) => {
    if (!node) return []
    if (ts.isStringLiteral(node)) return [node.text]
    if (ts.isConditionalExpression(node))
      return [...literals(node.whenTrue), ...literals(node.whenFalse)]
    return []
  }
  for (const file of await sources(path.join(root, 'frontend'))) {
    const ast = ts.createSourceFile(
      file,
      await readFile(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true
    )
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'triggerAction'
      ) {
        for (const name of literals(node.arguments[0])) {
          if (!accepted.has(name)) missing.add(name)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  assert.deepEqual(
    [...missing].sort(),
    [],
    'Controller switches must not be rejected as unknown actions'
  )
})

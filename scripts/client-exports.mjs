// Loads named exports of the ESM client modules for the checker scripts (check-keys, render-check).
// The modules are bundled exactly like client/index.js — same esbuild options — but through a virtual entry,
// so a script can pull out internal names (App, DICTS, PANEL_CSS, …) without shipping them.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'client', 'src')
const require = createRequire(import.meta.url)
const esbuild = require('esbuild')

export function loadClient(exportsMap, { react }) {
  // `import './index.js'` runs every module's top-level code (dictionaries register into PAGE_TEXT that way);
  // the exports below then pull out the names the checker needs.
  const contents = ["import './index.js'", ...Object.entries(exportsMap)
    .map(([name, from]) => `export { ${name} } from './${from}'`)].join('\n')
  const result = esbuild.buildSync({
    stdin: { contents, resolveDir: src, sourcefile: 'client-exports.js', loader: 'js' },
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    external: ['react'],
    loader: { '.js': 'jsx' },
    jsx: 'transform',
    jsxFactory: 'h',
    jsxFragment: 'React.Fragment',
    write: false,
    logLevel: 'silent',
  })
  const file = result.outputFiles.find(entry => !entry.path.endsWith('.map'))
  if (!file) throw new Error('esbuild returned no output')
  const module = { exports: {} }
  const load = new Function('require', 'module', 'exports', file.text)
  load(name => {
    if (name === 'react') return react ?? require('react')
    throw new Error(`unexpected require(${name})`)
  }, module, module.exports)
  return module.exports
}

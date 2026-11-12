// Exercise the actual npm tarball in an isolated consumer, not workspace source resolution.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
const temp = mkdtempSync(join(tmpdir(), 'parseltongue-package-'))
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (cmd, args, cwd = temp) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

try {
  run(process.execPath, [compiler, '-p', 'tsconfig.build.json'], root)
  const [packed] = JSON.parse(run(npm, ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], root))
  const files = packed.files.map(f => f.path)
  assert(files.includes('dist/index.js'))
  assert(files.includes('dist/index.d.ts'))
  assert(files.includes('LICENSE'))
  assert(files.every(f => f === 'package.json' || ['README.md', 'LICENSE', 'CHANGELOG.md'].includes(f) || f.startsWith('dist/')))

  // No runtime imports can escape the package or require a Node/browser shim.
  for (const file of files.filter(f => f.endsWith('.js'))) {
    const code = readFileSync(join(root, file), 'utf8')
    for (const match of code.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
      assert(match[1].startsWith('./'), `Unexpected external runtime import: ${match[1]}`)
    }
  }

  writeFileSync(join(temp, 'package.json'), JSON.stringify({ private: true, type: 'module' }))
  run(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, packed.filename)])
  writeFileSync(join(temp, 'check.mjs'), `
import assert from 'node:assert/strict'
import * as parser from '@shortdiv/parseltongue'
const raw = JSON.stringify({ type: 'session', version: 3, id: 'package-test', cwd: '/example', timestamp: '2026-01-01T00:00:00Z' })
assert.equal(parser.normalizeSession(raw).id, 'pi:package-test')
assert.equal(parser.parseSession(raw).agent, 'pi')
assert.equal(parser.reader('pi').entries.size, 0)
for (const name of ['bill', 'AGENTS', 'SessionDataset', 'projectName']) assert.equal(name in parser, false)
`)
  run(process.execPath, ['check.mjs'])

  // Compile a consumer with only ES libs: published declarations must not need @types/node.
  writeFileSync(join(temp, 'check.ts'), `
import { normalizeSession, reader, type NormalizedSession } from '@shortdiv/parseltongue'
const session: NormalizedSession = normalizeSession('')
const parser = reader('pi')
parser.read('')
export { session, parser }
`)
  writeFileSync(join(temp, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    lib: ['ES2022'], types: [], noEmit: true,
  }, include: ['check.ts'] }))
  run(process.execPath, [compiler, '-p', 'tsconfig.json'])
  console.log(`Package check passed: ${packed.filename}; isolated ESM import and browser-safe declarations verified.`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}

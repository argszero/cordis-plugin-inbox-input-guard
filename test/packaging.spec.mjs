/**
 * Packaging invariants.
 *
 * Two failures this task has already paid for downstream, both of which only
 * installing the packed artifact can witness: a runtime import the published
 * manifest does not declare at all (the package installs and then fails to
 * import), and a harness package declared as a runtime `dependency` (npm nests
 * a second copy, which is how identity-based lookups start failing). The first
 * two tests read the manifest and the build output; the third asks npm what
 * would actually ship.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const built = readFileSync(join(root, 'lib/index.js'), 'utf8')
const source = readFileSync(join(root, 'src/index.ts'), 'utf8')

const BARE_IMPORT = /(?:^|\n)\s*import\s(?:type\s)?(?:[^'"]*?\sfrom\s)?['"]([^'"]+)['"]/gu

/**
 * Every external specifier a file imports.
 * @param text - built JavaScript or TypeScript source.
 * @returns the bare specifiers, in first-seen order.
 */
function bareImports(text) {
  const found = new Set()
  for (const [, specifier] of text.matchAll(BARE_IMPORT)) {
    assert.ok(specifier !== undefined)
    if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
    if (specifier.startsWith('import(')) continue
    found.add(specifier)
  }
  return [...found]
}

test('every runtime import is a declared dependency or peer', () => {
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ])
  const imported = bareImports(built)
  // `@deepseek-ai/schemastery` is the only real runtime dependency; `dsh-llm`
  // supplies `createUserMessage`/`boundContextSummary` and stays a peer, so a
  // consumer's own copy is the one that runs.
  assert.deepEqual(imported, ['@deepseek-ai/dsh-llm', '@deepseek-ai/schemastery'])
  for (const specifier of imported) {
    assert.ok(declared.has(specifier), `${specifier} is imported but not declared`)
  }
})

test('every declared runtime dependency is actually imported', () => {
  // The mirror direction: a declared-but-unused dependency would ship a second
  // copy of a package nothing imports.
  const imported = new Set(bareImports(built))
  for (const specifier of Object.keys(pkg.dependencies ?? {})) {
    assert.ok(imported.has(specifier), `${specifier} is declared but never imported`)
  }
  // And every package the source imports at all (types included) is declared at
  // least as a peer, because a consumer needs its declarations to compile.
  const declared = new Set([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ])
  for (const specifier of bareImports(source)) {
    assert.ok(declared.has(specifier), `${specifier} is imported by the source but not declared`)
  }
})

test('harness packages are peers, never nested copies', () => {
  for (const harness of ['@deepseek-ai/cordis', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm']) {
    assert.ok(pkg.peerDependencies?.[harness] !== undefined, `${harness} must be a peerDependency`)
    assert.equal(pkg.dependencies?.[harness], undefined, `${harness} must not be a runtime dependency`)
  }
  // Semver admits a prerelease only when a comparator carries the same
  // [major, minor, patch] tuple with a prerelease of its own, so each tested
  // line needs its own clause — a single caret range would silently exclude the
  // line this plugin was actually run against. No semver implementation ships
  // in this tree, so what is asserted here is that condition itself: for every
  // harness version actually installed and run, the peer range carries a
  // prerelease comparator on the same tuple.
  const tested = Object.entries(pkg.devDependencies ?? {})
    // Exact pins are the lines this plugin was run against; a range here says
    // nothing about which version that was.
    .filter(([name, version]) => pkg.peerDependencies?.[name] !== undefined && /^\d+\.\d+\.\d+/u.test(version))
  assert.ok(tested.length >= 2, 'the harness lines this plugin was run against are pinned as dev dependencies')
  for (const [harness, version] of tested) {
    const range = pkg.peerDependencies[harness]
    const [tuple] = version.split(/[-+]/u)
    assert.ok(range.includes(`${tuple}-`), `${harness} range must admit ${version} (no ${tuple}-* clause)`)
  }
  // And the line the report itself ran on, which this plugin was built to serve.
  for (const harness of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm']) {
    assert.ok(pkg.peerDependencies[harness].includes('0.1.5-rc.1'), `${harness} range must admit 0.1.5-rc.1`)
  }
})

test('the packed artifact carries the patch, the entry and the licence', () => {
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(root, 'lib/types/index.d.ts')), 'types must be emitted')
  assert.ok(existsSync(join(root, 'cordis.patch.yml')))
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /^- insert:/mu)
  assert.match(patch, new RegExp(pkg.name, 'u'))
  assert.match(patch, /id: inbox-input-guard/u)

  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: root }).toString())
  const files = packed[0].files.map(entry => entry.path)
  for (const required of ['lib/index.js', 'cordis.patch.yml', 'README.md', 'LICENSE', 'package.json']) {
    assert.ok(files.includes(required), `${required} must ship`)
  }
  assert.ok(files.some(file => file.startsWith('lib/types/')), 'declarations must ship')
  assert.ok(!files.some(file => file.startsWith('test/')), 'tests must not ship')
  assert.ok(!files.some(file => file.startsWith('src/')), 'sources must not ship')
})

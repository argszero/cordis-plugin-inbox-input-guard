/**
 * Behaviour probe for the *published* artifact: this file imports the plugin by
 * its npm name, so it must run in a directory where the package was installed
 * from the registry — never in this repository's own tree (where a relative
 * import would silently test `lib/` instead of the released bytes).
 *
 *   mkdir -p /tmp/probe && cd /tmp/probe
 *   npm i @argszero/cordis-plugin-inbox-input-guard \
 *         @deepseek-ai/dsh-agent-loop @deepseek-ai/dsh-agent-loop-testkit \
 *         @deepseek-ai/dsh-time-context
 *   node <this-repo>/scripts/probe-installed.mjs
 *
 * Both mount spellings are exercised, because they differ: a bundle-patch loader
 * mounts the module namespace and Cordis resolves the exported `Config`, while
 * the `ctx.plugin({ name, inject, apply })` form passes no config at all. A
 * package that only works under one of them is a package that fails on the
 * machine of whoever copied the other idiom.
 *
 * The gap it closes is the one that has bitten this family of plugins: `npm
 * test` in the repository resolves through `../lib/`, so it cannot see a runtime
 * import the manifest never declared. Only installing by name, from an empty
 * directory, exercises the shipped closure. Both arms run here, because the
 * control arm is what makes the repair evidence rather than an assertion.
 */

import { agentEvents } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as timeContext from '@deepseek-ai/dsh-time-context'
import * as plugin from '@argszero/cordis-plugin-inbox-input-guard'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Refuse to run where the name resolves to this repository's own build. An npm
// install in the package directory self-links the package, so an in-tree run
// imports `lib/index.js` and passes — the same false green this probe exists to
// prevent, one level up.
const here = dirname(dirname(fileURLToPath(import.meta.url)))
const resolved = fileURLToPath(import.meta.resolve('@argszero/cordis-plugin-inbox-input-guard'))
if (resolved === join(here, 'lib', 'index.js')) {
  console.error(
    'This probe must run where the package was installed from the registry, not in its own tree:\n'
    + '  mkdir -p /tmp/probe && cd /tmp/probe && npm i @argszero/cordis-plugin-inbox-input-guard\n'
    + '  node ' + fileURLToPath(import.meta.url) + '\n'
    + `Resolved to: ${resolved}`,
  )
  process.exit(2)
}

const GARBAGE = 'a bare string from a plugin'
const CRASH = "Cannot read properties of undefined (reading 'kind')"
const SIGNAL = new AbortController().signal

/** Mount the standard fixture: real services, real reader, real loop. */
async function fixture() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(timeContext)
  const harness = await mountAgentLoopTestHarness(ctx)
  return { ctx, harness }
}

/** Dispatch the loop's pre-step waterfall the way its own call site does. */
function dispatch(ctx, agent, batch) {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: batch, turn: 1, step: 1, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter', messages: batch }),
  )
}

// ---------------------------------------------------------------- control arm
const control = await fixture()
const controlAgent = await control.harness.create(SessionId('probe-control'))
controlAgent.inbox.splice('next-turn', 0, 0, [GARBAGE])
const controlBatch = control.harness.claim(controlAgent, 'next-turn', 1)
let controlError
try {
  await dispatch(control.ctx, controlAgent, controlBatch)
} catch (error) {
  controlError = error
}
await control.ctx.fiber.dispose()

// ---------------------------------------------------------------- guarded arm
const guarded = await fixture()
// The bare-object form: no `Config` for Cordis to resolve, so `apply` must cope
// with no config argument of its own.
await guarded.ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
const guardedAgent = await guarded.harness.create(SessionId('probe-guarded'))
guardedAgent.inbox.splice('next-turn', 0, 0, [GARBAGE])
const decision = await dispatch(guarded.ctx, guardedAgent, guarded.harness.claim(guardedAgent, 'next-turn', 1))
const api = guarded.ctx.get(plugin.API_NAME)
const repaired = decision.messages[0]
await guarded.ctx.fiber.dispose()

// ------------------------------------------------------- namespace-mount arm
const namespaced = await fixture()
await namespaced.ctx.plugin(plugin)
const namespacedAgent = await namespaced.harness.create(SessionId('probe-namespace'))
namespacedAgent.inbox.splice('next-turn', 0, 0, [GARBAGE])
const namespacedDecision = await dispatch(
  namespaced.ctx, namespacedAgent, namespaced.harness.claim(namespacedAgent, 'next-turn', 1),
)
await namespaced.ctx.fiber.dispose()

const checks = {
  // The defect the report describes is real in the artifact, not only in source.
  controlCrashes: controlError !== undefined && controlError.message === CRASH,
  controlErrorMessage: controlError?.message === CRASH,
  // And the plugin is what stops it.
  guardedEnters: decision.kind === 'enter',
  guardedDeliveredVerbatim: repaired?.content?.[0]?.text === GARBAGE,
  guardedAttributesTheRepair: repaired?.source?.plugin === plugin.name && repaired?.source?.form === 'notice',
  guardedReturnsItsOwnContext: decision.messages[1]?.source?.plugin === 'time-context',
  guardedCounts: api?.counts().repaired === 1,
  guardedDisclosesTheWrite: api?.violations()[0]?.origin === 'durable',
  serviceExposed: api !== undefined,
  // And the way a bundle patch actually mounts it.
  namespaceMountRepairs: namespacedDecision.kind === 'enter'
    && namespacedDecision.messages.length === 2,
}
console.log(JSON.stringify({
  plugin: plugin.name,
  version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
  resolvedFrom: resolved,
  controlError: controlError?.message,
  checks,
}, null, 2))
const failed = Object.entries(checks).filter(([, value]) => !value).map(([key]) => key)
if (failed.length > 0) {
  console.error('FAILED:', failed)
  process.exit(1)
}
console.log(`installed-artifact behaviour: ${String(Object.keys(checks).length)}/${String(Object.keys(checks).length)}`)

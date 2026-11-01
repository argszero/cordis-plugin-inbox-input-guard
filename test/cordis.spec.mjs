/**
 * Behaviour tests against real Cordis, the real AgentLoop, a production Agent
 * with its real durable `Inbox`, and the real reader discussion #7363 names
 * (`@deepseek-ai/dsh-time-context`) — no stub of the inbox, the dispatch, the
 * reader, or the crash.
 *
 * The control arm is what makes the rest evidence: with no plugin mounted the
 * suite writes one non-message into the real inbox exactly as the report does,
 * claims it through the loop's own driver, and dispatches the `agent/pre-step`
 * waterfall. On the 0.1.5/0.1.6 lines the real `time-context` reader filtered
 * the pending list and threw the reported error; on the 0.2.1 line it walks the
 * session's durable events instead and never reads that value, so the arm
 * asserts what the line does — the value survives unread — rather than a crash
 * the line no longer produces. What the guard does is unchanged, and the same
 * dispatch with it mounted repairs the value and hands back time-context's own
 * context line.
 *
 * The suite pins promises that fail independently:
 *
 *  - **the defect is real** — the durable log accepts the bare string (only the
 *    duplicate-`id` guard looks at it) and a shipped reader throws on it;
 *  - **the claim is sanitized before the waterfall starts**, which is what makes
 *    the guarantee independent of listener registration order;
 *  - **a batch claimed before the guard existed is repaired at its entry**, and
 *    that agent is hooked for its later turns;
 *  - **nothing else moves** — a legal write and a legal batch record nothing,
 *    and the text the model sees is the producer's own, with the repair in the
 *    message source;
 *  - **each boundary is asserted, not described** — `report` mode still crashes
 *    and says so, a value the guard cannot render is dropped rather than
 *    guessed at, and the shadowed claim is restored on unmount, including a
 *    shadow that was already there.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { CONTEXT_SUMMARY_MAX_CHARS, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as agentInstructions from '@deepseek-ai/dsh-agent-instructions'
import * as timeContext from '@deepseek-ai/dsh-time-context'
import * as plugin from '../lib/index.js'

/** The reported error, verbatim from discussion #7363. */
const CRASH = "Cannot read properties of undefined (reading 'kind')"
/** The value the report's plugin produced: a bare string from a template. */
const GARBAGE = 'a bare string from a plugin'
const SIGNAL = new AbortController().signal

/** Format one logger call the way its own console sink renders it. */
function formatLog(args) {
  let index = 0
  return String(args[0]).replaceAll(/%s/g, () => String(args[(index += 1)]))
}

/**
 * Mount the prerequisite services, the real reader the report names, the real
 * loop, and warning capture. The guard is mounted by the caller, so a control
 * arm is the same fixture with one call removed.
 * @returns the context, the loop harness, and captured warnings.
 */
async function mountBase() {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(timeContext)
  // The second shipped reader of a claimed batch is also the only one that walks
  // the *pending* lists directly: it filters `inbox.nextStep` for its own
  // baseline context, and that filter reads `message.source.kind`.
  await ctx.plugin(agentInstructions, { maxBytes: 1_000_000 })
  const harness = await mountAgentLoopTestHarness(ctx)
  const warnings = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => {
      if (message.type === 'warn') warnings.push(formatLog(message.args))
    },
  })
  return { ctx, harness, warnings }
}

/** Mount the guard the way a bundle patch does. */
function mountGuard(ctx, config = {}) {
  return ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, config)
}

/** Put one non-message into the real durable inbox — the report's exact write. */
function poison(agent, value = GARBAGE, target = 'next-turn') {
  agent.inbox.splice(target, 0, 0, [value])
}

/** Dispatch the loop's pre-step waterfall in the shape its own call site uses. */
function dispatch(ctx, agent, batch, { turn = 1, step = 1, signal = SIGNAL } = {}) {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: batch, turn, step, signal },
    () => Promise.resolve({ kind: 'enter', messages: batch }),
  )
}

/** The guard's service, or a failure that names the missing mount. */
function guardApi(ctx) {
  const api = ctx.get(plugin.API_NAME)
  assert.notEqual(api, undefined, 'the guard service is mounted')
  return api
}

test('both mount spellings work: with no config at all, and with the namespace', async () => {
  // A bundle-patch loader mounts the module namespace, so Cordis resolves the
  // exported `Config` and `apply` receives the schema defaults. The
  // `{ name, inject, apply }` form carries no `Config` for Cordis to resolve and
  // passes `undefined` instead — which is how this suite's own mounts work, so
  // both spellings are pinned here rather than assumed.
  const bare = await mountBase()
  await bare.ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply })
  const bareAgent = await bare.harness.create(SessionId('bare-mount'))
  poison(bareAgent)
  const bareDecision = await dispatch(bare.ctx, bareAgent, bare.harness.claim(bareAgent, 'next-turn', 1))
  assert.equal(bareDecision.messages.length, 2, 'mounted with no config, the guard still repairs')
  assert.equal(guardApi(bare.ctx).counts().repaired, 1)
  await bare.ctx.fiber.dispose()

  const namespaced = await mountBase()
  await namespaced.ctx.plugin(plugin)
  const namespacedAgent = await namespaced.harness.create(SessionId('namespace-mount'))
  poison(namespacedAgent)
  const decision = await dispatch(
    namespaced.ctx, namespacedAgent, namespaced.harness.claim(namespacedAgent, 'next-turn', 1),
  )
  assert.equal(decision.messages.length, 2, 'mounted by namespace, the schema defaults are used')
  assert.equal(guardApi(namespaced.ctx).counts().repaired, 1)
  await namespaced.ctx.fiber.dispose()
})

test('control arm: the real reader throws the reported error on a bare string', async () => {
  const { ctx, harness } = await mountBase()
  const agent = await harness.create(SessionId('control'))
  poison(agent)

  // The durable log took it: this is the write the report shows, and the only
  // structural check at that boundary is the duplicate-id guard, which reads
  // `message.id` — undefined here — and lets a lone entry through. Read before
  // the claim, which appends its own (empty-insertion) splices.
  const spliced = agent.session.snapshotEvents().filter((event) => event.type === 'agent/inbox/spliced')
  assert.equal(spliced.length, 1)
  assert.deepEqual(spliced[0].data.inserted, [GARBAGE])

  const batch = harness.claim(agent, 'next-turn', 1)
  assert.equal(batch.length, 1)

  await assert.rejects(() => dispatch(ctx, agent, batch), (error) => {
    assert.equal(error.message, CRASH)
    return true
  })
  await ctx.fiber.dispose()
})

test('the guard keeps the real reader working: the turn proceeds and returns its own context', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx)
  const agent = await harness.create(SessionId('guarded'))
  poison(agent)
  const batch = harness.claim(agent, 'next-turn', 1)
  const decision = await dispatch(ctx, agent, batch)

  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 2)
  const repaired = decision.messages[0]
  assert.equal(plugin.isUsableUserMessage(repaired), true)
  assert.deepEqual(repaired.content, [{ type: 'text', text: GARBAGE }])
  assert.equal(repaired.source.kind, 'inbox-input-guard',
    'the repaired message carries this producer\'s own kind: the shared `plugin` kind is retired')
  assert.equal(repaired.source.plugin, plugin.name)
  assert.equal(repaired.source.form, 'notice')
  assert.match(repaired.source.summary, /repaired inbox input \(string\)/)
  // The reader that threw in the control arm ran to completion.
  const context = decision.messages[1]
  // The in-tree producer names itself: on the 0.2.1 line `time-context`
  // declares `kind: name`, not the retired shared literal, and carries no
  // redundant `plugin` field because its kind already says who wrote it.
  assert.equal(context.source.kind, 'time-context')
  assert.equal(context.source.form, 'snapshot')
  assert.equal(guardApi(ctx).counts().repaired, 1)
  await ctx.fiber.dispose()
})

test('control arm: the 0.2.1 reader no longer consults the pending list, and the inbox still takes the value', async () => {
  const { ctx, harness } = await mountBase()
  const agent = await harness.create(SessionId('control-pending'))
  // No claim covers this one: the value is put where the *next* step will look,
  // while the current turn is running.
  const batch = harness.claim(agent, 'next-turn', 1)
  agent.inbox.splice('next-step', 0, 0, [GARBAGE])

  // Two facts, both measured on this line, and the first one is a change.
  //
  // The reader this plugin was written against (`time-context`) used to filter
  // `inbox.nextStep` and read `message.source.kind` on every entry, which is
  // what threw the reported error. On the 0.2.1 line `requestMessages` walks the
  // session's durable events instead (`session.eventAt`), so a value sitting in
  // the pending list is never read at all and the turn completes. That upstream
  // change is not this plugin's doing, and the arm says so rather than claiming
  // a crash the line does not produce.
  const decision = await dispatch(ctx, agent, batch)
  assert.equal(decision.kind, 'enter')

  // What has NOT changed is the boundary: the inbox took the bare string without
  // complaint, and it is still there afterwards, so every reader that does look
  // at the pending list — another shipped plugin, a third-party one, a future
  // line that restores the read — is handed a value with no `source` at all.
  assert.deepEqual(agent.inbox.nextStep, [GARBAGE])
  assert.equal(agent.inbox.nextStep[0].source, undefined)

  await ctx.fiber.dispose()
})

test('the pending sweep closes that path, and repairs the value in place', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx)
  const agent = await harness.create(SessionId('pending-swept'))
  const batch = harness.claim(agent, 'next-turn', 1)
  agent.inbox.splice('next-step', 0, 0, [GARBAGE])

  const decision = await dispatch(ctx, agent, batch)
  assert.equal(decision.kind, 'enter')
  // The projection that the reader walks now holds a message, not a string.
  assert.equal(agent.inbox.nextStep.length, 1)
  assert.equal(plugin.isUsableUserMessage(agent.inbox.nextStep[0]), true)
  assert.deepEqual(agent.inbox.nextStep[0].content, [{ type: 'text', text: GARBAGE }])
  assert.equal(agent.inbox.nextStep[0].source.plugin, plugin.name)

  // Two records, because the value was seen twice: at the durable write, and
  // here in the projection. That is the point of the durable half — the two
  // entries are the same defect at two different moments.
  assert.deepEqual(
    guardApi(ctx).violations().map((entry) => `${entry.origin}:${entry.action}`),
    ['durable:observed', 'pending:repaired'],
  )
  const [, violation] = guardApi(ctx).violations()
  assert.equal(violation.target, 'next-step')
  assert.equal(violation.valueKind, 'string')
  // The repair is a durable mutation like any other, so the log records it.
  const spliced = agent.session.snapshotEvents().filter((event) => event.type === 'agent/inbox/spliced')
  assert.deepEqual(spliced.at(-1).data.inserted.map((message) => message.source?.plugin), [plugin.name])
  await ctx.fiber.dispose()
})

test('the pending sweep walks each list in reverse, so no entry shifts past it', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx)
  const agent = await harness.create(SessionId('pending-mixed'))
  const batch = harness.claim(agent, 'next-turn', 1)
  const legal = createUserMessage({
    content: [{ type: 'text', text: 'waiting for the next step' }],
    source: { kind: 'user' },
  })
  // Two offenders in ONE list, with a legal entry between them: the first one is
  // removed (positions after it shift) and the last one is replaced. A forward
  // walk would splice the wrong live index for the second and leave the number
  // in place — which is why this ordering, not just the count, is asserted.
  agent.inbox.splice('next-step', 0, 0, [{ id: 'p1', role: 'user' }, legal, 7])
  // And one offender in the other list, so both branches are exercised.
  agent.inbox.splice('next-turn', 0, 0, [{ id: 'p2', role: 'user' }])

  await dispatch(ctx, agent, batch)
  // Nothing a reader could index is left un-rendered, in either list. This is
  // the assertion a forward walk fails: it splices the wrong live index for the
  // last entry and leaves the raw number sitting in the list. (The list is not
  // asserted to a fixed length: `agent-instructions` is mounted too, and its own
  // listener syncs its baseline context into `next-step` after the entries.)
  assert.equal(agent.inbox.nextStep.every(plugin.isUsableUserMessage), true)
  assert.equal(agent.inbox.nextTurn.every(plugin.isUsableUserMessage), true)
  // The number became its own text, and the legal message between the two
  // offenders is still there.
  const texts = agent.inbox.nextStep.map((message) => message.content[0]?.text)
  assert.ok(texts.includes('7'), `the repaired number is present: ${JSON.stringify(texts)}`)
  assert.ok(
    agent.inbox.nextStep.some((message) => message.id === legal.id),
    'the legal message between the two offenders is still pending',
  )
  const actions = guardApi(ctx).violations().map((entry) => `${entry.origin}:${entry.valueKind}:${entry.action}`)
  // Three durable writes held a non-message (two in `next-step`, one in
  // `next-turn`), and the sweep then handed each back at its own position.
  assert.deepEqual(actions, [
    'durable:object:observed', 'durable:number:observed', 'durable:object:observed',
    'pending:number:repaired', 'pending:object:quarantined', 'pending:object:quarantined',
  ])
  await ctx.fiber.dispose()
})

test('the pending sweep leaves legal entries exactly where they were', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx)
  const agent = await harness.create(SessionId('pending-legal'))
  const batch = harness.claim(agent, 'next-turn', 1)
  // Two distinct messages on purpose: the same identity in both lists is
  // rejected by the inbox's own duplicate guard, which is a different rule.
  const pending = createUserMessage({
    content: [{ type: 'text', text: 'waiting for the next step' }],
    source: { kind: 'user' },
  })
  const queued = createUserMessage({
    content: [{ type: 'text', text: 'waiting for the next turn' }],
    source: { kind: 'user' },
  })
  agent.inbox.splice('next-step', 0, 0, [pending])
  agent.inbox.splice('next-turn', 0, 0, [queued])

  await dispatch(ctx, agent, batch)
  // Both legal entries are untouched and still pending (each list also gains
  // whatever another mounted listener chooses to sync in; that is not this
  // guard's business).
  assert.ok(agent.inbox.nextStep.some((message) => message.id === pending.id))
  assert.ok(agent.inbox.nextTurn.some((message) => message.id === queued.id))
  assert.deepEqual(guardApi(ctx).violations(), [])
  await ctx.fiber.dispose()
})

test('the claim itself is clean, before any listener has run', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx)
  const agent = await harness.create(SessionId('clean-claim'))
  poison(agent)
  // What the loop's own driver hands to every listener.
  const batch = harness.claim(agent, 'next-turn', 1)
  assert.equal(batch.length, 1)
  assert.equal(plugin.isUsableUserMessage(batch[0]), true)
  assert.deepEqual(batch[0].content, [{ type: 'text', text: GARBAGE }])
  await ctx.fiber.dispose()
})

test('no listener order can matter: entry readers and after-next readers both see legal input', async () => {
  const { ctx, harness } = await mountBase()
  const atEntry = []
  const afterNext = []
  // Registered before the guard and placed first, so this entry runs ahead of
  // the guard's own entry and reads the batch at the earliest possible moment.
  ctx.on('agent/pre-step', async (payload, next) => {
    for (const message of payload.messages) atEntry.push(plugin.isUsableUserMessage(message))
    const decision = await next()
    if (decision.kind === 'enter') for (const message of decision.messages) afterNext.push(plugin.isUsableUserMessage(message))
    return decision
  }, { prepend: true })
  await mountGuard(ctx)

  const agent = await harness.create(SessionId('order'))
  poison(agent)
  const decision = await dispatch(ctx, agent, harness.claim(agent, 'next-turn', 1))

  assert.deepEqual(atEntry, [true], 'the first reader to run was handed a message, not a string')
  assert.deepEqual(afterNext, [true, true], 'the repaired entry and time-context’s own line')
  assert.equal(decision.messages.length, 2)
  await ctx.fiber.dispose()
})

test('an agent that predates the mount is repaired at the entry, then hooked', async () => {
  const { ctx, harness } = await mountBase()
  const agent = await harness.create(SessionId('pre-existing'))
  poison(agent)
  // Mounted after the agent exists, so `agent/created` never reached the guard.
  await mountGuard(ctx)

  const batch = harness.claim(agent, 'next-turn', 1)
  assert.equal(plugin.isUsableUserMessage(batch[0]), false, 'this claim happened before the hook')
  const decision = await dispatch(ctx, agent, batch)
  assert.equal(decision.messages[0].content[0].text, GARBAGE)
  assert.equal(guardApi(ctx).counts().repaired, 1)

  // The same agent's later turns are covered at the claim instead.
  poison(agent)
  const later = harness.claim(agent, 'next-turn', 1)
  assert.equal(plugin.isUsableUserMessage(later[0]), true, 'the entry hook is installed by then')
  assert.equal(guardApi(ctx).counts().repaired, 2)
  await ctx.fiber.dispose()
})

test('the durable half names the defect at the write, before any turn runs', async () => {
  const { ctx, harness, warnings } = await mountBase()
  await mountGuard(ctx)
  const agent = await harness.create(SessionId('durable'))
  assert.deepEqual(guardApi(ctx).violations(), [])

  poison(agent)

  const [violation, ...rest] = guardApi(ctx).violations()
  assert.equal(rest.length, 0)
  assert.equal(violation.origin, 'durable')
  assert.equal(violation.sessionId, 'durable')
  assert.equal(typeof violation.seq, 'number')
  assert.equal(violation.target, 'next-turn')
  assert.equal(violation.index, 0)
  assert.equal(violation.valueKind, 'string')
  assert.equal(violation.preview, GARBAGE)
  assert.equal(violation.action, 'observed')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /inbox input guard: observed a string entry at log seq \d+ of session "durable"/)
  await ctx.fiber.dispose()
})

test('a legal inbox write and a legal batch record nothing at all', async () => {
  const { ctx, harness, warnings } = await mountBase()
  await mountGuard(ctx)
  const agent = await harness.create(SessionId('legal'))
  const legal = createUserMessage({
    content: [{ type: 'text', text: 'an ordinary prompt' }],
    source: { kind: 'user' },
  })
  agent.inbox.splice('next-turn', 0, 0, [legal])
  const decision = await dispatch(ctx, agent, harness.claim(agent, 'next-turn', 1))
  // Deep-equality, not identity: the inbox hands out its projection state, so
  // even an untouched message arrives as an equal copy.
  assert.deepEqual(decision.messages[0], legal)
  assert.deepEqual(guardApi(ctx).violations(), [])
  assert.deepEqual(guardApi(ctx).counts(), { repaired: 0, quarantined: 0, observed: 0 })
  assert.deepEqual(warnings, [])
  await ctx.fiber.dispose()
})

test('quarantine removes every non-message it is handed', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx, { mode: 'quarantine' })
  const agent = await harness.create(SessionId('quarantined'))
  // `next-step` is claimed whole, so both entries reach the guard in one batch.
  // They carry distinct ids because the durable write genuinely requires that
  // (see the collision test); an object with an id but no role/kind is exactly
  // the shape that walks past the write-path check.
  agent.inbox.splice('next-step', 0, 0, [{ id: 'p1' }, { id: 'p2' }])
  const batch = harness.claim(agent, 'next-turn', 1)
  assert.equal(batch.length, 0)
  assert.equal(guardApi(ctx).counts().quarantined, 2)
  // Each entry is seen twice: once at the durable write, once in the batch.
  assert.deepEqual(guardApi(ctx).violations().map((entry) => entry.origin), ['durable', 'durable', 'claimed', 'claimed'])
  assert.deepEqual(guardApi(ctx).violations().map((entry) => entry.valueKind), ['object', 'object', 'object', 'object'])
  await ctx.fiber.dispose()
})

test('repair mode never fabricates content for a value it cannot render', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx)
  const agent = await harness.create(SessionId('non-scalar'))
  // Message-shaped but not a message: forwarding it would push
  // `role: undefined` at the provider instead of fixing anything.
  poison(agent, { role: 'user', content: [{ type: 'text', text: 'no id, no source' }] })
  const batch = harness.claim(agent, 'next-turn', 1)
  assert.equal(batch.length, 0)
  assert.equal(guardApi(ctx).counts().quarantined, 1)
  assert.equal(guardApi(ctx).counts().repaired, 0)
  assert.equal(guardApi(ctx).violations()[0].valueKind, 'object')
  await ctx.fiber.dispose()
})

test('the message contract is asserted whole, not only at the crash-relevant field', async () => {
  // The crash only needs `source.kind`, but an entry missing the rest is not a
  // message the loop can commit either. Each shape below is an object with a
  // readable `id`, so the durable write accepts it and the guard is the only
  // thing between it and a reader.
  const incomplete = {
    'no role or content': { id: 's1', source: { kind: 'user' } },
    'no content': { id: 's2', role: 'user', source: { kind: 'user' } },
    'content is not a list': { id: 's3', role: 'user', content: 'text', source: { kind: 'user' } },
    'no source kind': { id: 's4', role: 'user', content: [], source: {} },
    'no source at all': { id: 's5', role: 'user', content: [] },
    'empty id': { id: '', role: 'user', content: [], source: { kind: 'user' } },
    'the wrong role': { id: 's7', role: 'assistant', content: [], source: { kind: 'user' } },
  }
  for (const [label, value] of Object.entries(incomplete)) {
    assert.equal(plugin.isUsableUserMessage(value), false, label)
  }
  // And the contract is about shape, not about who produced it: an injected
  // message with a plugin source is a message.
  const injected = createUserMessage({
    content: [{ type: 'text', text: 'injected' }],
    source: { kind: 'somewhere-else', plugin: 'somewhere-else', form: 'notice', summary: 'x' },
  })
  assert.equal(plugin.isUsableUserMessage(injected), true)

  const { ctx, harness } = await mountBase()
  await mountGuard(ctx)
  const agent = await harness.create(SessionId('incomplete'))
  poison(agent, incomplete['no role or content'])
  const batch = harness.claim(agent, 'next-turn', 1)
  assert.equal(batch.length, 0, 'a half-shaped object is dropped, never forwarded')
  assert.equal(guardApi(ctx).counts().quarantined, 1)
  await ctx.fiber.dispose()
})

test('report mode changes nothing — including the crash it reports', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx, { mode: 'report' })
  const agent = await harness.create(SessionId('report'))
  poison(agent)
  const batch = harness.claim(agent, 'next-turn', 1)
  assert.equal(plugin.isUsableUserMessage(batch[0]), false)
  await assert.rejects(() => dispatch(ctx, agent, batch), (error) => {
    assert.equal(error.message, CRASH)
    return true
  })
  // Everything is on record: the durable write, then the entry handed to the
  // reader unchanged at the claim and again at the pre-step entry — report mode
  // repairs nothing, so each pass sees the same value and says so.
  assert.equal(guardApi(ctx).counts().observed, 3)
  assert.deepEqual(guardApi(ctx).violations().map((entry) => entry.origin), ['durable', 'claimed', 'claimed'])
  await ctx.fiber.dispose()
})

test('previewChars bounds every record', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx, { previewChars: 8 })
  const agent = await harness.create(SessionId('bounded'))
  poison(agent, 'x'.repeat(400))
  assert.equal(guardApi(ctx).violations()[0].preview, `${'x'.repeat(8)}…`)
  await ctx.fiber.dispose()
})

test('unmount restores the claim it shadowed, including a shadow already there', async () => {
  for (const preWrapped of [false, true]) {
    const { ctx, harness } = await mountBase()
    const agent = await harness.create(SessionId(`restore-${String(preWrapped)}`))
    const inherited = agent.inbox.claim
    let outer
    if (preWrapped) {
      // Another guard got here first: the inbox now carries an own `claim`.
      outer = (target, turn) => inherited.call(agent.inbox, target, turn)
      agent.inbox.claim = outer
    }
    assert.equal(Object.hasOwn(agent.inbox, 'claim'), preWrapped)

    const guard = await mountGuard(ctx)
    // Created before the mount, so this agent is hooked by the guard's own
    // pre-step entry rather than by `agent/created`.
    await dispatch(ctx, agent, harness.claim(agent, 'next-turn', 1))
    assert.notEqual(agent.inbox.claim, preWrapped ? outer : inherited)

    await guard.dispose()

    assert.equal(Object.hasOwn(agent.inbox, 'claim'), preWrapped, 'the prior state is restored exactly')
    assert.equal(agent.inbox.claim, preWrapped ? outer : inherited)
    // The wrapper is gone behaviourally, not just by name.
    poison(agent)
    assert.equal(plugin.isUsableUserMessage(harness.claim(agent, 'next-turn', 1)[0]), false)
    await ctx.fiber.dispose()
  }
})

test('an agent seen twice is hooked once, and each entry is repaired once', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx)
  const agent = await harness.create(SessionId('idempotent'))
  poison(agent)
  const batch = harness.claim(agent, 'next-turn', 1)
  const installed = agent.inbox.claim
  // Both hook paths fire for this agent: creation already did, and every
  // pre-step tries again.
  await dispatch(ctx, agent, batch)
  await dispatch(ctx, agent, batch, { step: 2 })
  assert.equal(agent.inbox.claim, installed, 'no second wrapper was stacked')
  assert.equal(guardApi(ctx).counts().repaired, 1, 'repaired once, not once per listener')
  assert.equal(guardApi(ctx).violations().length, 2, 'the durable write and the claim, and nothing more')
  guardApi(ctx).reset()
  assert.deepEqual(guardApi(ctx).counts(), { repaired: 0, quarantined: 0, observed: 0 })
  assert.deepEqual(guardApi(ctx).violations(), [])
  await ctx.fiber.dispose()
})

test('a second bare string in one splice is rejected by the id guard, not by this plugin', async () => {
  const { ctx, harness } = await mountBase()
  const agent = await harness.create(SessionId('collision'))
  // Two bare strings collide on the one property the durable guard reads:
  // `message.id` is `undefined` for both. Recorded here because it is the
  // boundary the upstream fix has to widen — a lone string slips through it.
  assert.throws(
    () => agent.inbox.splice('next-turn', 0, 0, [GARBAGE, GARBAGE]),
    /message "undefined" is already pending/,
  )
  // And the same property read rejects the two values for which it throws:
  // null and undefined never reach a reader, and the error names neither them
  // nor this plugin.
  assert.throws(() => agent.inbox.splice('next-turn', 0, 0, [null]), TypeError)
  assert.throws(() => agent.inbox.splice('next-turn', 0, 0, [undefined]), TypeError)
  await ctx.fiber.dispose()
})

/* ── the assembly half ────────────────────────────────────────────────────────
 * A second question at the same seam, from discussion #11575: phantom user
 * messages reached a model request that the user never typed and that the log
 * never held. The guard already observes this seam; these arms pin the audit it
 * now keeps of it.
 *
 * The rig is the real one, which decides the shape of every expectation here:
 * the guard's listener is outermost, the shipped `time-context` reader wraps
 * inside it and appends its own snapshot, and a test listener registered last
 * runs innermost. So one quiet step legitimately adds the `time-context`
 * message, and the arms assert that addition explicitly — the built-in
 * continuation is the case the audit must *not* call an anomaly.
 */

/** A message that declares itself the work of some producer. */
function messageFrom(kind, text = 'from a producer') {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind } })
}

/** A message the loop's own readers accept: a user message with a source. */
function legalPrompt(text) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** The message the shipped reader appends to every step; the built-in continuation's shape. */
const BUILT_IN = 'time-context'

/** Register a listener after the guard, so it runs inside the guard's `next()`. */
function appendAfterGuard(ctx, build) {
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    return { ...decision, messages: build(decision.messages) }
  })
}

/** One quiet dispatch: a legal prompt claimed, one step run. */
async function oneStep(ctx, harness, id, turn = 1) {
  const agent = await harness.create(SessionId(id))
  agent.inbox.splice('next-turn', 0, 0, [legalPrompt('a legal message')])
  const decision = await dispatch(ctx, agent, harness.claim(agent, 'next-turn', turn), { turn })
  return { agent, decision }
}

test('a quiet step records the built-in continuation as an addition and calls nothing anomalous', async () => {
  const { ctx, harness, warnings } = await mountBase()
  await mountGuard(ctx)
  await oneStep(ctx, harness, 'assembly-clean')

  const [record, ...rest] = guardApi(ctx).assembly()
  assert.equal(rest.length, 0)
  assert.equal(record.claimed, 1, 'the claim is what the inbox handed the loop')
  assert.equal(record.admitted, 2, 'the claim plus the reader’s own context')
  assert.equal(record.added, 1)
  assert.deepEqual(record.addedAt, [1])
  assert.deepEqual(record.addedKinds, [BUILT_IN], 'the built-in append declares its own kind')
  assert.equal(record.addedAsUser, 0)
  assert.equal(record.addedEmpty, 0)
  assert.equal(record.dropped, 0)
  assert.equal(record.outcome, 'enter')
  assert.equal(record.anomalous, false)
  assert.equal(record.sessionId, 'assembly-clean')
  assert.equal(record.turn, 1)
  assert.equal(record.step, 1)
  assert.deepEqual(warnings, [], 'a healthy step writes no log line')
  assert.deepEqual(guardApi(ctx).assemblyCounts(), { steps: 1, anomalous: 0, errors: 0 })
  await ctx.fiber.dispose()
})

test('a message admitted as user-authored that the inbox never delivered is recorded — and left in place', async () => {
  const { ctx, harness, warnings } = await mountBase()
  await mountGuard(ctx)
  const phantom = messageFrom('user', 'text the human never typed')
  appendAfterGuard(ctx, (messages) => [...messages, phantom])
  const { decision } = await oneStep(ctx, harness, 'assembly-phantom')

  const [record] = guardApi(ctx).assembly()
  assert.equal(record.claimed, 1)
  assert.equal(record.admitted, 3)
  assert.equal(record.added, 2)
  assert.deepEqual(record.addedAt, [1, 2], 'position 1 is where the request gains text')
  assert.deepEqual(record.addedKinds, ['user', BUILT_IN])
  assert.equal(record.addedAsUser, 1)
  assert.equal(record.anomalous, true)
  // Observing is the whole contract: the guard does not remove it, and the loop
  // receives the message the listener added.
  assert.equal(decision.messages.includes(phantom), true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /session "assembly-phantom" turn 1 step 1 admitted 1 message\(s\) the inbox did not deliver/)
  assert.match(warnings[0], /positions 1\)$/)
  await ctx.fiber.dispose()
})

test('a producer that declares its own kind is reported, not flagged', async () => {
  const { ctx, harness, warnings } = await mountBase()
  await mountGuard(ctx)
  appendAfterGuard(ctx, (messages) => [...messages, messageFrom('runtime-context')])
  await oneStep(ctx, harness, 'assembly-context')

  const [record] = guardApi(ctx).assembly()
  assert.equal(record.added, 2)
  assert.deepEqual(record.addedKinds, ['runtime-context', BUILT_IN])
  assert.equal(record.addedAsUser, 0)
  assert.equal(record.anomalous, false)
  assert.deepEqual(warnings, [], 'a declared producer is the mechanism working, not a finding')
  await ctx.fiber.dispose()
})

test('a duplicate of a claimed message is an addition too — the shape the report describes', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx)
  // The same object handed back a second time: a set would collapse it, which is
  // why the audit counts occurrences.
  appendAfterGuard(ctx, (messages) => [messages[0], ...messages])
  await oneStep(ctx, harness, 'assembly-dup')

  const [record] = guardApi(ctx).assembly()
  assert.equal(record.claimed, 1)
  assert.equal(record.added, 2)
  assert.deepEqual(record.addedAt, [1, 2])
  assert.deepEqual(record.addedKinds, ['user', BUILT_IN])
  assert.equal(record.addedAsUser, 1, 'the copy still presents itself as the human')
  assert.equal(record.dropped, 0, 'nothing was lost — the original is still there')
  assert.equal(record.anomalous, true)
  await ctx.fiber.dispose()
})

test('an empty added message is counted as empty, without reading anything', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx)
  const empty = createUserMessage({ content: [], source: { kind: 'user' } })
  appendAfterGuard(ctx, (messages) => [...messages, empty])
  await oneStep(ctx, harness, 'assembly-empty')

  const [record] = guardApi(ctx).assembly()
  assert.equal(record.addedEmpty, 1)
  assert.equal(record.addedAsUser, 1)
  await ctx.fiber.dispose()
})

test('a rejected step admits nothing and is recorded as such', async () => {
  const { ctx, harness, warnings } = await mountBase()
  await mountGuard(ctx)
  ctx.on('agent/pre-step', async (_payload, next) => { await next(); return { kind: 'reject' } })
  const { decision } = await oneStep(ctx, harness, 'assembly-reject')

  assert.equal(decision.kind, 'reject')
  const [record] = guardApi(ctx).assembly()
  assert.equal(record.outcome, 'reject')
  assert.equal(record.admitted, 0)
  assert.equal(record.added, 0)
  assert.equal(record.dropped, 1)
  assert.equal(record.anomalous, false)
  assert.deepEqual(warnings, [])
  await ctx.fiber.dispose()
})

test('content-freedom: no text, argument or path from the payload reaches any record, log line, error or count', async () => {
  // Three sentinels in the shapes a real session carries: the human's text, a
  // path, and a tool argument. None of them is something a diagnostic may keep.
  const TEXT_SENTINEL = 'ZZTEXTSENTINEL9f3a1'
  const PATH_SENTINEL = 'ZZPATHSENTINEL9f3a1/private/notes.txt'
  const ARG_SENTINEL = 'ZZARGSENTINEL9f3a1'

  const { ctx, harness } = await mountBase()
  const lines = []
  ctx.logger.exporter({
    levels: { default: 4 },
    export: (message) => { lines.push(formatLog(message.args)) },
  })
  await mountGuard(ctx)

  const carried = createUserMessage({
    content: [
      { type: 'text', text: TEXT_SENTINEL },
      { type: 'text', text: `read ${PATH_SENTINEL}` },
      { type: 'text', text: `{"path":"${ARG_SENTINEL}"}` },
    ],
    source: { kind: 'user' },
  })
  const phantom = messageFrom('user', `${TEXT_SENTINEL} ${PATH_SENTINEL} ${ARG_SENTINEL}`)
  appendAfterGuard(ctx, (messages) => [...messages, phantom])

  const agent = await harness.create(SessionId('assembly-secret'))
  agent.inbox.splice('next-turn', 0, 0, [carried])
  await dispatch(ctx, agent, harness.claim(agent, 'next-turn', 1))

  // Every sink this plugin owns, serialized whole.
  const api = guardApi(ctx)
  const haystack = JSON.stringify({
    assembly: api.assembly(),
    violations: api.violations(),
    counts: api.counts(),
    assemblyCounts: api.assemblyCounts(),
    log: lines,
  })
  for (const sentinel of [TEXT_SENTINEL, PATH_SENTINEL, ARG_SENTINEL]) {
    assert.equal(haystack.includes(sentinel), false, `no sink may carry ${sentinel}`)
  }
  // And the record is asserted to be metadata only, not merely observed to be.
  const [record] = api.assembly()
  assert.deepEqual(Object.keys(record).sort(), [
    'added', 'addedAsUser', 'addedAt', 'addedEmpty', 'addedKinds',
    'admitted', 'anomalous', 'at', 'claimed', 'dropped', 'outcome', 'sessionId', 'step', 'turn',
  ])
  assert.equal(record.anomalous, true, 'the arm really did carry content into the batch')
  assert.ok(lines.length >= 1, 'the finding really was logged, so the log was really searched')
  await ctx.fiber.dispose()
})

test('a kind that is not a slug is reported as unrecognized rather than echoed', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx)
  appendAfterGuard(ctx, (messages) => [...messages, messageFrom('ZZTEXTSENTINEL9f3a1 is my kind')])
  await oneStep(ctx, harness, 'assembly-kind')

  const [record] = guardApi(ctx).assembly()
  assert.deepEqual(record.addedKinds, ['unrecognized', BUILT_IN])
  assert.equal(JSON.stringify(record).includes('ZZTEXTSENTINEL9f3a1'), false)
  await ctx.fiber.dispose()
})

test('fail-open: a decision the audit cannot read never breaks the turn', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx)
  // Unreadable to the *audit* specifically: `source` is well formed, so every
  // other reader in the waterfall is satisfied, and `content` throws only for
  // the code that counts it.
  const hostile = {
    id: 'hostile',
    role: 'user',
    source: { kind: 'user' },
    get content() { throw new Error('audit probe: unreadable content') },
  }
  appendAfterGuard(ctx, (messages) => [...messages, hostile])
  const { decision } = await oneStep(ctx, harness, 'assembly-failopen')

  assert.equal(decision.messages.includes(hostile), true, 'the loop gets its own decision back untouched')
  assert.deepEqual(guardApi(ctx).assemblyCounts(), { steps: 0, anomalous: 0, errors: 1 })
  await ctx.fiber.dispose()
})

test('the record bound drops the oldest while the totals keep counting', async () => {
  const { ctx, harness } = await mountBase()
  await mountGuard(ctx, { assemblyLimit: 2 })
  const agent = await harness.create(SessionId('assembly-bound'))
  for (let turn = 1; turn <= 4; turn += 1) {
    agent.inbox.splice('next-turn', 0, 0, [legalPrompt(`message ${turn}`)])
    await dispatch(ctx, agent, harness.claim(agent, 'next-turn', turn), { turn })
  }
  const records = guardApi(ctx).assembly()
  assert.equal(records.length, 2)
  assert.deepEqual(records.map((record) => record.turn), [3, 4], 'oldest dropped first')
  assert.equal(guardApi(ctx).assemblyCounts().steps, 4, 'the totals outlive the records')
  await ctx.fiber.dispose()
})

/*
 * The install face — the one thing a unit test of the source cannot see.
 *
 * `dsh plugin add` exits 0 and the entry appears in the composed config even when
 * the installed module cannot be imported at all: a profile resolves the plugin's
 * own `dependencies`, and the harness packages it peers on live in the `dsh` CLI's
 * tree, out of reach of a module loaded from a profile. These arms therefore read
 * the BUILD rather than the source — a value import of `@deepseek-ai/dsh-llm` is
 * the difference between a plugin that runs and one that throws
 * `ERR_MODULE_NOT_FOUND` before its first line — and pin each carried primitive
 * to the real module, which is resolvable here and nowhere else.
 */

/** A value import of the harness-only peer, which a profile cannot resolve. */
const LLM_PEER_VALUE_IMPORT = /(?:^|\n)\s*import\s[^;\n]*?from\s*['"]@deepseek-ai\/dsh-llm['"]/

/** A freshly minted identity, the shape the harness's own `randomUUID()` gives. */
const FRESH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('the built entry imports no harness peer a profile cannot resolve', async () => {
  const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.doesNotMatch(
    source,
    LLM_PEER_VALUE_IMPORT,
    'a value import of dsh-llm throws ERR_MODULE_NOT_FOUND when the installed copy is loaded from a profile',
  )
  assert.match(source, /['"]node:crypto['"]/, 'the identity the carried constructor mints comes from node, not the harness')
})

test('the carried primitives are reachable from the build', () => {
  const carried = plugin.carriedLlmPrimitives
  assert.equal(typeof carried?.createUserMessage, 'function', 'the entry exports its carried message constructor')
  assert.equal(typeof carried?.boundContextSummary, 'function', 'the entry exports its carried summary bound')
  assert.equal(carried?.CONTEXT_SUMMARY_MAX_CHARS, CONTEXT_SUMMARY_MAX_CHARS, 'the constant is the harness\'s own')
})

test('the carried summary bound agrees with the harness at every boundary', async () => {
  const { boundContextSummary: carried } = plugin.carriedLlmPrimitives
  for (const length of [0, 1, 118, 119, 120, 121, 200, 500]) {
    const summary = 'x'.repeat(length)
    assert.equal(carried(summary), boundContextSummary(summary), `summary of length ${String(length)}`)
  }
  const atBound = 'y'.repeat(CONTEXT_SUMMARY_MAX_CHARS)
  assert.equal(carried(atBound), atBound, 'a summary exactly at the bound is left alone')
  assert.equal(carried(`${atBound}z`).length, CONTEXT_SUMMARY_MAX_CHARS, 'one character over is still bounded')
})

test('the carried message constructor produces what the harness produces', () => {
  const input = {
    content: [{ type: 'text', text: 'repaired inbox input (string)' }],
    source: {
      kind: 'inbox-input-guard',
      plugin: 'inbox-input-guard',
      form: 'notice',
      summary: 'repaired inbox input (string)',
    },
  }
  const carried = plugin.carriedLlmPrimitives.createUserMessage(input)
  const upstream = createUserMessage(input)
  assert.equal(carried.role, upstream.role, 'the role is the same')
  assert.deepEqual(Object.keys(carried).sort(), Object.keys(upstream).sort(), 'no key the harness does not write')
  assert.match(carried.id, FRESH_ID, 'the identity is a fresh uuid the harness would accept')
  const id = carried.id
  assert.equal(plugin.carriedLlmPrimitives.createUserMessage(input).id === id, false, 'every call mints its own identity')
  const { id: carriedId, ...carriedRest } = structuredClone(carried)
  const { id: upstreamId, ...upstreamRest } = structuredClone(upstream)
  assert.notEqual(carriedId, upstreamId, 'two constructors never collide')
  assert.deepEqual(carriedRest, upstreamRest, 'everything but the identity is identical')
})

test('the carried message is frozen the way the harness freezes messages', () => {
  const carried = plugin.carriedLlmPrimitives.createUserMessage({
    content: [{ type: 'text', text: 'a' }],
    source: { kind: 'inbox-input-guard', plugin: 'inbox-input-guard', form: 'notice', summary: 'frozen' },
  })
  assert.ok(Object.isFrozen(carried), 'the message')
  assert.ok(Object.isFrozen(carried.content), 'the content array')
  assert.ok(Object.isFrozen(carried.content[0]), 'the content block')
  assert.ok(Object.isFrozen(carried.source), 'the source')
  assert.throws(() => { carried.content[0].text = 'b' }, TypeError, 'a frozen block refuses the write')
})

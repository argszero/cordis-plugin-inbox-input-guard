/**
 * Behaviour tests against real Cordis, the real AgentLoop, a production Agent
 * with its real durable `Inbox`, and the real reader discussion #7363 names
 * (`@deepseek-ai/dsh-time-context`) — no stub of the inbox, the dispatch, the
 * reader, or the crash.
 *
 * The control arm is what makes the rest evidence: with no plugin mounted the
 * suite writes one non-message into the real inbox exactly as the report does,
 * claims it through the loop's own driver, dispatches the `agent/pre-step`
 * waterfall, and the real `time-context` reader throws the reported error. The
 * same dispatch with the guard mounted completes and hands back time-context's
 * own context line.
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
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
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
  assert.equal(repaired.source.kind, 'plugin')
  assert.equal(repaired.source.plugin, plugin.name)
  assert.equal(repaired.source.form, 'notice')
  assert.match(repaired.source.summary, /repaired inbox input \(string\)/)
  // The reader that threw in the control arm ran to completion.
  const context = decision.messages[1]
  assert.equal(context.source.kind, 'plugin')
  assert.equal(context.source.plugin, 'time-context')
  assert.equal(guardApi(ctx).counts().repaired, 1)
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
    source: { kind: 'plugin', plugin: 'somewhere-else', form: 'notice', summary: 'x' },
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

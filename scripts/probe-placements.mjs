/**
 * Which readers throw on a non-message, and does the guard cover all of them?
 *
 * Three placements are exercised with a real loop, a real time-context and a
 * real agent-instructions (if mountable): a string left in `next-turn`, a string
 * left in `next-step` before a claim, and a string injected into `next-step`
 * while a turn is already running.
 */
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as timeContext from '@deepseek-ai/dsh-time-context'
import * as agentInstructions from '@deepseek-ai/dsh-agent-instructions'
import * as guard from '../lib/index.js'

const GARBAGE = 'a bare string from a plugin'
const SIGNAL = new AbortController().signal

async function fixture(withGuard) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(timeContext)
  await ctx.plugin(agentInstructions, { maxBytes: 1_000_000 })
  const harness = await mountAgentLoopTestHarness(ctx)
  if (withGuard) await ctx.plugin({ name: guard.name, inject: guard.inject, apply: guard.apply })
  return { ctx, harness }
}

function dispatch(ctx, agent, batch, step = 1) {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: batch, turn: 1, step, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter', messages: batch }),
  )
}

async function scenario(label, withGuard, place) {
  const { ctx, harness } = await fixture(withGuard)
  const agent = await harness.create(SessionId(`s-${label}-${String(withGuard)}`))
  const batch = place(agent, harness)
  let outcome
  try {
    const decision = await dispatch(ctx, agent, batch)
    outcome = `OK messages=${String(decision.messages.length)}`
  } catch (error) {
    outcome = `THREW ${error.constructor.name}: ${error.message}`
  }
  // Also ask what the inert surface looks like after the pass.
  const nextStep = agent.inbox.nextStep.map((m) => (typeof m === 'string' ? `<${typeof m}>` : 'msg'))
  await ctx.fiber.dispose()
  return { outcome, nextStep: JSON.stringify(nextStep) }
}

const cases = {
  'next-turn splice': (agent, harness) => {
    agent.inbox.splice('next-turn', 0, 0, [GARBAGE])
    return harness.claim(agent, 'next-turn', 1)
  },
  'next-step splice': (agent, harness) => {
    agent.inbox.splice('next-step', 0, 0, [GARBAGE])
    return harness.claim(agent, 'next-turn', 1)
  },
  'next-step injected mid-turn': (agent, harness) => {
    harness.claim(agent, 'next-turn', 1)
    agent.inbox.splice('next-step', 0, 0, [GARBAGE])
    return []
  },
}

for (const [label, place] of Object.entries(cases)) {
  for (const withGuard of [false, true]) {
    const result = await scenario(label, withGuard, place)
    console.log(`${withGuard ? 'guarded  ' : 'control  '} ${label.padEnd(28)} ${result.outcome.padEnd(64)} nextStep=${result.nextStep}`)
  }
}

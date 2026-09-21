/**
 * Inbox input guard for the DeepSeek Harness agent loop.
 *
 * A claimed inbox entry that is not a `UserMessage` crashes the turn inside
 * whichever module reads it first, and the report is filed against that reader.
 * Discussion #7363 traces it end to end: a plugin calls
 * `agent.followup('some string')`, the string is spliced into the durable inbox
 * unvalidated, the next turn claims it, and ~1ms after `turn/start` — before any
 * `step/start` — the turn ends with
 * `Cannot read properties of undefined (reading 'kind')` thrown from
 * `time-context`'s browser-zone reader (`const source = message.source;
 * source.kind === ...`), a module that never saw the offending plugin.
 *
 * This plugin keeps that value from reaching any reader.
 *
 * ## Where it acts
 *
 * 1. **At claim.** For every agent it can hook — through `agent/created`, and
 *    through the first `agent/pre-step` of an agent that predates this mount —
 *    it wraps `agent.inbox.claim()`, so the batch the loop hands to the
 *    `agent/pre-step` waterfall is already sanitized. This is the single point
 *    where the loop takes ownership of the input, so it is independent of
 *    listener registration order: every reader, however it is ordered, sees only
 *    the sanitized batch.
 * 2. **At the pre-step entry.** For a batch that was claimed before this plugin
 *    could hook the agent, the guard sanitizes `payload.messages` in place at its
 *    own listener entry. Entries run outermost-first and every listener's
 *    `next()` continuation runs after all entries, so a reader that reads the
 *    batch after calling `next()` — every shipped reader — sees the repair.
 * 3. **On the durable write.** A `session/event` observer records every
 *    non-message that reaches `agent/inbox/spliced`, with the session, the log
 *    seq, the inbox list and a bounded rendering. This is the signal the report
 *    above did not have: the defect is named at the moment it is committed,
 *    instead of surfacing as a crash in an unrelated module. It observes only —
 *    a plugin cannot rewrite committed history.
 *
 * ## What it does with the value
 *
 * - `repair` (default): a scalar (`string`, `number`, `boolean`, `bigint`) is
 *   **delivered verbatim** as a user message whose source records the repair
 *   (`plugin`, `form: 'notice'`), so the producer's intended text still reaches
 *   the model and the transcript shows where it came from.
 * - `quarantine`: every non-message is removed from the batch, and the turn
 *   proceeds without it.
 * - `report`: nothing is touched — the guard records what it saw. Turn behavior
 *   is exactly what it is without the plugin, including the crash.
 *
 * Anything that is not a scalar is dropped in `repair` mode as well. The guard
 * does not fabricate content for a value whose text it cannot read: an object
 * that is not a message has no unambiguous rendering, and forwarding a
 * half-shaped object is a different failure (`role: undefined` reaches the
 * provider) rather than a fix.
 *
 * Honest boundaries: a plugin cannot validate the write side — the durable
 * `agent/inbox/spliced` record keeps whatever was spliced, and it cannot name
 * the offending plugin, because the inbox records a value and not a caller. The
 * upstream fix is a shape check at the inbox write boundary (and a real check in
 * `inboxProjectionSchema`, whose `z.custom<UserMessage>()` accepts any value on
 * resume); this plugin is the consumer-side half that keeps a session usable
 * until that lands.
 *
 * @module @argszero/cordis-plugin-inbox-input-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'inbox-input-guard'

/** Core events and the agent's own inbox are all this plugin reaches. */
export const inject: readonly string[] = []

/** Service name exposing what this mount saw. */
export const API_NAME = 'inboxInputGuard'

/** What the guard may do with an entry that is not a usable user message. */
export type GuardMode = 'repair' | 'quarantine' | 'report'

/** Where a violation was seen: in the durable log, or in a claimed batch. */
export type ViolationOrigin = 'durable' | 'claimed'

/** What the guard did about it. `observed` is also what the durable half does. */
export type ViolationAction = 'repaired' | 'quarantined' | 'observed'

/** Deployment configuration. */
export interface Config {
  /**
   * `repair` delivers a scalar verbatim and drops anything else;
   * `quarantine` drops every non-message; `report` changes nothing.
   */
  readonly mode?: GuardMode
  /** Characters of the offending value kept in a record and in the log line. */
  readonly previewChars?: number
}

export const Config: z<Config> = z.object({
  mode: z.union([z.const('repair'), z.const('quarantine'), z.const('report')]).default('repair'),
  previewChars: z.number().default(80),
})

/** One inbox entry the guard would not hand to the loop unchanged. */
export interface InboxViolation {
  /** Epoch milliseconds at which the guard saw it. */
  readonly at: number
  readonly origin: ViolationOrigin
  /** Session whose pending input this was. */
  readonly sessionId: string
  /** Durable `agent/inbox/spliced` position, when the violation was seen in the log. */
  readonly seq: number | null
  /** Inbox list or claim target the entry sat in. */
  readonly target: string | null
  /** Position inside that list, or inside the claimed batch. */
  readonly index: number
  /** Runtime kind of the offending value. */
  readonly valueKind: string
  /** Bounded, single-line rendering of the value. */
  readonly preview: string
  readonly action: ViolationAction
}

/** The guard's read surface, reachable as `ctx.get('inboxInputGuard')`. */
export interface InboxInputGuardApi {
  /** Every violation this mount saw, oldest first. */
  violations(): readonly InboxViolation[]
  /** Per-action totals for this mount. */
  counts(): Readonly<Record<ViolationAction, number>>
  /** Drop the records; hooks stay installed. */
  reset(): void
}

/** One inbox boundary name, structurally typed to avoid a service dependency. */
type TargetName = 'next-step' | 'next-turn'

/** The claimed-batch signature this plugin wraps. */
type Claim = (target: TargetName, turn: number) => UserMessage[]

/** Structural view of the inbox the guard wraps. */
interface InboxLike {
  claim: Claim
}

/**
 * Whether an entry is the message the loop and its readers can be handed: the
 * durable `UserMessage` shape those events declare.
 *
 * The crash-relevant half is the last check — every reader reaches
 * `message.source.kind` — but an entry that fails the rest is not a message the
 * loop can commit either, so the guard treats the whole shape as the contract.
 * @param value - one entry from a claimed batch or a durable inbox splice.
 * @returns true when the value can be handed to the loop unchanged.
 */
export function isUsableUserMessage(value: unknown): value is UserMessage {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { id?: unknown; role?: unknown; content?: unknown; source?: unknown }
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return false
  if (candidate.role !== 'user') return false
  if (!Array.isArray(candidate.content)) return false
  const source = candidate.source
  return typeof source === 'object'
    && source !== null
    && typeof (source as { kind?: unknown }).kind === 'string'
}

/** A short, stable name for a runtime value. */
function valueKindOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type === 'object') {
    const constructor = (value as { constructor?: { name?: unknown } }).constructor
    const named = typeof constructor?.name === 'string' ? constructor.name : ''
    return named.length > 0 && named !== 'Object' ? `object (${named})` : 'object'
  }
  return type
}

/**
 * The text a scalar contributes verbatim.
 * @param value - the offending entry.
 * @returns its text, or undefined when the guard must not guess at it.
 */
function verbatimText(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return value
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value)
    default:
      return undefined
  }
}

/** One bounded, single-line rendering of a value; never executes the value. */
function previewOf(value: unknown, max: number): string {
  let rendered: string
  if (typeof value === 'string') {
    rendered = value
  } else {
    try {
      const json = JSON.stringify(value)
      rendered = json === undefined ? String(value) : json
    } catch {
      rendered = `<unserializable ${valueKindOf(value)}>`
    }
  }
  const single = rendered.replaceAll(/\s+/g, ' ')
  return single.length <= max ? single : `${single.slice(0, max)}…`
}

/**
 * Mount the guard.
 *
 * The default argument is deliberate: a bundle-patch loader mounts the module
 * namespace, so Cordis resolves `Config` and this receives the schema defaults —
 * but the `ctx.plugin({ name, inject, apply })` form, which is how the harness's
 * own tests mount a plugin, carries no `Config` for Cordis to resolve and passes
 * `undefined` instead. Both spellings have to work.
 * @param ctx - host context; nothing beyond core events is required.
 * @param config - mode and preview bound.
 */
export function apply(ctx: Context, config: Config = {} as Config): void {
  const mode: GuardMode = config.mode ?? 'repair'
  const previewChars = config.previewChars ?? 80
  const violations: InboxViolation[] = []
  const counts: Record<ViolationAction, number> = { repaired: 0, quarantined: 0, observed: 0 }
  const wrapped = new Map<Agent, { inbox: InboxLike; hadOwn: boolean; original: Claim }>()

  const record = (violation: InboxViolation): void => {
    violations.push(violation)
    counts[violation.action] += 1
    ctx.logger.warn(
      'inbox input guard: %s a %s entry at %s of session "%s" — %s: %s',
      violation.action,
      violation.valueKind,
      violation.origin === 'durable'
        ? `log seq ${String(violation.seq)}`
        : `claimed position ${String(violation.index)}`,
      violation.sessionId,
      violation.origin === 'durable'
        ? 'the durable inbox now holds it'
        : 'it was handed to this turn',
      violation.preview,
    )
  }

  /**
   * Repair or drop every non-message in one batch, in place.
   *
   * In place on purpose: the array is the one the loop claimed and the one every
   * `agent/pre-step` listener is handed, so replacing elements fixes the batch
   * for all of them at once rather than for the listeners a returned decision
   * happens to reach.
   */
  const sanitize = (
    batch: UserMessage[],
    origin: ViolationOrigin,
    sessionId: string,
    seq: number | null,
    target: string | null,
  ): void => {
    for (let index = 0; index < batch.length; index += 1) {
      const value: unknown = batch[index]
      if (isUsableUserMessage(value)) continue
      const violation: Omit<InboxViolation, 'action'> = {
        at: 0,
        origin,
        sessionId,
        seq,
        target,
        index,
        valueKind: valueKindOf(value),
        preview: previewOf(value, previewChars),
      }
      const text = mode === 'repair' ? verbatimText(value) : undefined
      if (text !== undefined) {
        batch[index] = createUserMessage({
          content: [{ type: 'text', text }],
          source: {
            kind: 'plugin',
            plugin: name,
            form: 'notice',
            summary: boundContextSummary(`repaired inbox input (${violation.valueKind})`),
          },
        })
        record({ ...violation, at: Date.now(), action: 'repaired' })
        continue
      }
      if (mode === 'report') {
        record({ ...violation, at: Date.now(), action: 'observed' })
        continue
      }
      batch.splice(index, 1)
      index -= 1
      record({ ...violation, at: Date.now(), action: 'quarantined' })
    }
  }

  const restore = (agent: Agent): void => {
    const entry = wrapped.get(agent)
    if (entry === undefined) return
    wrapped.delete(agent)
    const holder = entry.inbox as unknown as Record<string, unknown>
    if (entry.hadOwn) holder['claim'] = entry.original
    else delete holder['claim']
  }

  /**
   * Sanitize this agent's next claims by wrapping the one call the loop takes
   * its input through. A wrapped `claim` is what makes the guard independent of
   * listener order, because the batch is clean before the waterfall starts.
   */
  const hook = (agent: Agent): void => {
    if (wrapped.has(agent)) return
    const inbox = agent.inbox as unknown as InboxLike | undefined
    if (inbox === undefined || inbox === null || typeof inbox.claim !== 'function') return
    const original = inbox.claim
    const hadOwn = Object.hasOwn(inbox, 'claim')
    const sessionId = String(agent.session.id)
    const holder = inbox as unknown as Record<string, unknown>
    holder['claim'] = function guardedClaim(target: TargetName, turn: number): UserMessage[] {
      const batch = original.call(inbox, target, turn)
      sanitize(batch, 'claimed', sessionId, null, String(target))
      return batch
    } satisfies Claim
    wrapped.set(agent, { inbox, hadOwn, original })
    // The agent's own scope owns the shadow, so an agent that ends unwraps
    // itself; the mount-level effect below is the backstop for agents whose
    // context never disposes (and for the case where the wrap outlives us).
    agent.ctx?.effect(() => () => { restore(agent) }, 'inbox-input-guard.restore()')
  }

  ctx.on('agent/created', ({ agent }): undefined => { hook(agent); return undefined })

  ctx.on('agent/pre-step', (payload, next) => {
    // An agent that predates this mount has no wrapped claim yet: its current
    // batch is repaired here, and hooking it covers every later turn.
    sanitize(payload.messages, 'claimed', String(payload.agent.session.id), null, null)
    hook(payload.agent)
    return next()
  }, { prepend: true })

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'agent/inbox/spliced') return
    const inserted = (event.data as { inserted?: readonly unknown[] }).inserted
    if (!Array.isArray(inserted)) return
    const target = String((event.data as { target?: unknown }).target ?? '')
    for (let index = 0; index < inserted.length; index += 1) {
      const value: unknown = inserted[index]
      if (isUsableUserMessage(value)) continue
      record({
        at: Date.now(),
        origin: 'durable',
        sessionId: String(session.id),
        seq: event.seq,
        target: target.length > 0 ? target : null,
        index,
        valueKind: valueKindOf(value),
        preview: previewOf(value, previewChars),
        action: 'observed',
      })
    }
  })

  ctx.provide(API_NAME, {
    violations: (): readonly InboxViolation[] => violations.slice(),
    counts: (): Readonly<Record<ViolationAction, number>> => ({ ...counts }),
    reset: (): void => {
      violations.length = 0
      counts.repaired = 0
      counts.quarantined = 0
      counts.observed = 0
    },
  } satisfies InboxInputGuardApi)

  ctx.effect(() => () => {
    for (const agent of [...wrapped.keys()]) restore(agent)
  }, 'inbox-input-guard.unwrap()')
}

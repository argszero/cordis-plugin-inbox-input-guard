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
 * 2b. **At the pending lists.** The claimed batch is not the only place a reader
 *    looks. `agent/inbox.nextStep` / `nextTurn` are projection reads, and a value
 *    injected into `next-step` while a turn is running is visible there before
 *    any claim takes it out — `agent-instructions`, for one, walks that list and
 *    reads `message.source.kind`. The guard therefore sweeps both pending lists
 *    at its entry too, repairing or dropping through `inbox.splice`, the public
 *    primitive for a pending-list mutation.
 * 3. **On the durable write.** A `session/event` observer records every
 *    non-message that reaches `agent/inbox/spliced`, with the session, the log
 *    seq, the inbox list and a bounded rendering. This is the signal the report
 *    above did not have: the defect is named at the moment it is committed,
 *    instead of surfacing as a crash in an unrelated module. It observes only —
 *    a plugin cannot rewrite committed history.
 * 4. **Around the waterfall.** The same `agent/pre-step` listener also audits
 *    the *assembly*: it snapshots the claimed batch, calls `next()`, and
 *    compares what the decision carries against what was claimed. Messages the
 *    decision added that were not in the claim were manufactured during this
 *    step, and a message that presents itself as user-authored
 *    (`source.kind: 'user'`) while not coming from the claim is text standing in
 *    for a human who never typed it. The record is metadata only — positions,
 *    counts, and a bounded producer slug — so it can be shipped in a report
 *    about a session whose text is private. See *Reading the assembly*.
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

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

export const name = 'inbox-input-guard'

/**
 * This producer's own message-source kind.
 *
 * The harness retired the shared `plugin` catch-all: `MessageSourceMap` is
 * merge-extensible, each producer declares its own kind in its own module, and
 * consumers fall through kinds they do not know. The repaired message therefore
 * says which producer wrote it instead of borrowing a name the type surface no
 * longer carries.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'inbox-input-guard': {
      kind: 'inbox-input-guard'
      plugin?: string
      form?: 'notice'
      summary?: string
    }
  }
}

/*
 * The two `@deepseek-ai/dsh-llm` primitives this entry calls, carried locally.
 *
 * A profile resolves a plugin's own `dependencies` and nothing else: the harness
 * packages a third-party plugin peers on live in the `dsh` CLI's tree, which a
 * module loaded out of a profile cannot resolve. A value import of
 * `@deepseek-ai/dsh-llm` therefore makes the installed copy fail to load —
 * `ERR_MODULE_NOT_FOUND` at import time, before a single line of the plugin runs
 * — even though `dsh plugin add` exits 0 and the entry appears in the composed
 * config. The two primitives are reproduced below, and `test/cordis.spec.mjs`
 * pins each against the real module, so drift in the harness turns into a red
 * test here instead of a silent behaviour difference in a profile.
 *
 * Sources at dsh 0.2.1-rc.5: `packages/llm/llm/src/message.ts` —
 * `CONTEXT_SUMMARY_MAX_CHARS` (:122), `boundContextSummary` (:129),
 * `createMessage` (:221), `createUserMessage` (:246) — and `deepFreeze` from
 * `packages/util/values/src/index.ts` (:195). The brands `createMessage` applies
 * (`brandString<MessageId>`) are compile-time only, so the identity below is the
 * same string the harness itself would have minted.
 */

/** Longest `notice` summary the harness emits before truncating it. */
export const CONTEXT_SUMMARY_MAX_CHARS = 120

/**
 * Bound one `notice` summary to {@link CONTEXT_SUMMARY_MAX_CHARS}.
 * @param summary - summary text to bound.
 * @returns the summary, truncated with an ellipsis when it is too long.
 */
export function boundContextSummary(summary: string): string {
  return summary.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/**
 * Deep-freeze an object graph in place while leaving live AbortSignal objects mutable.
 * @param value - value to freeze.
 * @returns the same value after every reachable enumerable child is frozen.
 */
function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: (
    | { kind: 'visit'; node: unknown }
    | { kind: 'property'; source: Record<string, unknown>; key: string }
  )[] = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object') continue
    if (node instanceof AbortSignal) continue
    if (seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      if (key === undefined) continue
      pending.push({ kind: 'property', source: node as Record<string, unknown>, key })
    }
  }
  return value
}

/**
 * Create one identified, immutable user message.
 * @param input - content plus the producer source describing the message.
 * @returns a frozen user message with a fresh stable identity.
 */
function createUserMessage(input: Omit<UserMessage, 'id' | 'role'>): UserMessage {
  return deepFreeze(structuredClone({
    ...input,
    id: randomUUID() as UserMessage['id'],
    role: 'user' as const,
  }))
}

/**
 * @internal The carried primitives, exported so the suite can pin them against
 * the real `@deepseek-ai/dsh-llm` in the development rig — the one place that
 * module is resolvable.
 */
export const carriedLlmPrimitives = {
  CONTEXT_SUMMARY_MAX_CHARS,
  boundContextSummary,
  createUserMessage,
}

/** Core events and the agent's own inbox are all this plugin reaches. */
export const inject: readonly string[] = []

/** Service name exposing what this mount saw. */
export const API_NAME = 'inboxInputGuard'

/** What the guard may do with an entry that is not a usable user message. */
export type GuardMode = 'repair' | 'quarantine' | 'report'

/** Where a violation was seen: committed to the log, still pending, or claimed. */
export type ViolationOrigin = 'durable' | 'pending' | 'claimed'

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
  /**
   * Assembly records kept per mount, oldest dropped first. The audit is on for
   * every step; this only bounds what is retained for `assembly()`.
   */
  readonly assemblyLimit?: number
}

export const Config: z<Config> = z.object({
  mode: z.union([z.const('repair'), z.const('quarantine'), z.const('report')]).default('repair'),
  previewChars: z.number().default(80),
  assemblyLimit: z.number().default(256),
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

/**
 * One step's assembly, recorded without any of its content.
 *
 * Every field is a count, a position, or a producer slug. No message text, no
 * tool argument, no path and no `notice` summary is read or retained: those are
 * caller text, and a diagnostic that quotes them cannot be attached to a report
 * about a session whose content is private.
 */
export interface AssemblyRecord {
  /** Epoch milliseconds at which the step settled. */
  readonly at: number
  /** Session whose step this was. */
  readonly sessionId: string
  readonly turn: number
  readonly step: number
  /** Messages the loop claimed and handed to the waterfall. */
  readonly claimed: number
  /** Messages the decision carries (`0` when the step was rejected). */
  readonly admitted: number
  /** Admitted messages that were not in the claim, by identity. */
  readonly added: number
  /** Positions of those messages inside the admitted batch. */
  readonly addedAt: readonly number[]
  /** Bounded producer slug of each added message, in order. */
  readonly addedKinds: readonly string[]
  /** Added messages that present themselves as user-authored. */
  readonly addedAsUser: number
  /** Added messages carrying no content block at all. */
  readonly addedEmpty: number
  /** Claimed messages the decision no longer carries. */
  readonly dropped: number
  readonly outcome: 'enter' | 'reject'
  /**
   * Whether a reader should look at this step: something was admitted as a user
   * message without coming from the inbox. That is the only anomaly this audit
   * asserts — an added message of any other kind is a producer declaring itself,
   * which is how the mechanism is meant to work.
   */
  readonly anomalous: boolean
}

/** Step totals for this mount, independent of how many records were retained. */
export interface AssemblyCounts {
  /** Steps audited, including those whose record was dropped by the bound. */
  readonly steps: number
  /** Steps that admitted a user-authored message the inbox never delivered. */
  readonly anomalous: number
  /** Steps whose audit itself failed; the turn was never affected. */
  readonly errors: number
}

/** The guard's read surface, reachable as `ctx.get('inboxInputGuard')`. */
export interface InboxInputGuardApi {
  /** Every violation this mount saw, oldest first. */
  violations(): readonly InboxViolation[]
  /** Per-action totals for this mount. */
  counts(): Readonly<Record<ViolationAction, number>>
  /** Retained assembly records, oldest first, bounded by `assemblyLimit`. */
  assembly(): readonly AssemblyRecord[]
  /** Step totals, which outlive the record bound. */
  assemblyCounts(): AssemblyCounts
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

/** A producer-declared source kind is a slug: lowercase, short, no spaces or paths. */
const SOURCE_KIND_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/

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
  const assemblyRecords: AssemblyRecord[] = []
  const assemblyLimit = Math.max(1, Math.trunc(config.assemblyLimit ?? 256))
  const assemblyTotals = { steps: 0, anomalous: 0, errors: 0 }
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
   * The message one repaired scalar becomes: the producer's own text, with the
   * repair recorded in the source so the transcript says where it came from.
   */
  const repairOf = (text: string, valueKind: string): UserMessage => createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: name,
      plugin: name,
      form: 'notice',
      summary: boundContextSummary(`repaired inbox input (${valueKind})`),
    },
  })

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
        batch[index] = repairOf(text, violation.valueKind)
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

  /**
   * Repair or drop non-messages still sitting in the *pending* lists, which
   * readers index directly rather than through a claimed batch.
   *
   * `agent/inbox/{nextStep,nextTurn}` are projection reads, and at least one
   * shipped module walks them and touches `message.source.kind`
   * (`agent-instructions` looks for its own baseline context). A value injected
   * into `next-step` while a turn is running is therefore visible to that reader
   * before any claim takes it out — the claim path alone does not cover it.
   *
   * Mutating through `inbox.splice` is the public primitive for exactly this,
   * and it records the change durably like any other pending-list mutation. Each
   * list is walked backwards so removing or replacing one entry cannot shift the
   * position of another still to be examined.
   */
  const sanitizePending = (agent: Agent): void => {
    for (const target of ['next-step', 'next-turn'] as const) {
      const list: readonly unknown[] = target === 'next-step' ? agent.inbox.nextStep : agent.inbox.nextTurn
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const value: unknown = list[index]
        if (isUsableUserMessage(value)) continue
        const violation: Omit<InboxViolation, 'action'> = {
          at: Date.now(),
          origin: 'pending',
          sessionId: String(agent.session.id),
          seq: null,
          target,
          index,
          valueKind: valueKindOf(value),
          preview: previewOf(value, previewChars),
        }
        const text = mode === 'repair' ? verbatimText(value) : undefined
        if (text !== undefined) {
          agent.inbox.splice(target, index, 1, [repairOf(text, violation.valueKind)])
          record({ ...violation, action: 'repaired' })
          continue
        }
        if (mode === 'report') {
          record({ ...violation, action: 'observed' })
          continue
        }
        agent.inbox.splice(target, index, 1, [])
        record({ ...violation, action: 'quarantined' })
      }
    }
  }

  /**
   * A producer's own name for itself, bounded to a slug.
   *
   * `MessageSourceMap` is merge-extensible, so a kind is whatever its producer
   * declares — caller-controlled in principle. A record meant to be safe to ship
   * therefore reports a kind it can recognise as a slug and `unrecognized`
   * otherwise, rather than echoing a value that could be anything.
   */
  const sourceKindOf = (message: UserMessage): string => {
    const kind = (message as { source?: { kind?: unknown } }).source?.kind
    if (typeof kind !== 'string' || kind.length === 0) return 'unknown'
    return SOURCE_KIND_PATTERN.test(kind) ? kind : 'unrecognized'
  }

  /**
   * Record what one step did to the batch, without reading any of it.
   *
   * The comparison is identity, not content: a message in the decision that the
   * claim did not carry was produced during this step, and its `source.kind`
   * says what it claims to be. The built-in runtime-context append declares its
   * own kind (`runtime-context`), so it is visible here as an addition that is
   * *not* impersonating anyone — which is what makes `source.kind: 'user'` on an
   * added message the discriminator worth reporting.
   *
   * Only `source.kind` and `content.length` are read. Text, tool arguments,
   * paths and `notice` summaries are caller text and are never touched.
   */
  const auditStep = (
    agent: Agent,
    claimed: readonly UserMessage[],
    turn: number,
    step: number,
    decision: unknown,
  ): void => {
    const settlement = decision as { kind?: unknown; messages?: unknown }
    const admitted = settlement.kind === 'enter' && Array.isArray(settlement.messages)
      ? settlement.messages as readonly UserMessage[]
      : []
    // Occurrences, not membership: the report describes one message duplicated
    // up to twelve times, and a duplicate is the *same object* handed out again.
    // A set would collapse it and report nothing; a multiset consumes the claim
    // one occurrence at a time, so the second copy is what it is — an addition.
    const remaining = new Map<unknown, number>()
    for (const message of claimed) remaining.set(message, (remaining.get(message) ?? 0) + 1)
    const addedAt: number[] = []
    const addedKinds: string[] = []
    const asUserAt: number[] = []
    let addedAsUser = 0
    let addedEmpty = 0
    for (let index = 0; index < admitted.length; index += 1) {
      const message = admitted[index]
      if (message === undefined) continue
      const left = remaining.get(message) ?? 0
      if (left > 0) {
        remaining.set(message, left - 1)
        continue
      }
      addedAt.push(index)
      const kind = sourceKindOf(message)
      addedKinds.push(kind)
      if (kind === 'user') {
        addedAsUser += 1
        asUserAt.push(index)
      }
      const content = (message as { content?: unknown }).content
      if (Array.isArray(content) && content.length === 0) addedEmpty += 1
    }
    let dropped = 0
    for (const left of remaining.values()) dropped += left
    const record: AssemblyRecord = {
      at: Date.now(),
      sessionId: String(agent.session.id),
      turn,
      step,
      claimed: claimed.length,
      admitted: admitted.length,
      added: addedAt.length,
      addedAt,
      addedKinds,
      addedAsUser,
      addedEmpty,
      dropped,
      outcome: settlement.kind === 'reject' ? 'reject' : 'enter',
      anomalous: addedAsUser > 0,
    }
    assemblyRecords.push(record)
    if (assemblyRecords.length > assemblyLimit) {
      assemblyRecords.splice(0, assemblyRecords.length - assemblyLimit)
    }
    assemblyTotals.steps += 1
    if (!record.anomalous) return
    assemblyTotals.anomalous += 1
    // Loud only when something is wrong: a healthy step records silently, so the
    // log stays a signal instead of a per-step trace.
    ctx.logger.warn(
      'inbox input guard: session "%s" turn %s step %s admitted %s message(s) the inbox did not deliver, presenting as user-authored (positions %s)',
      record.sessionId,
      String(turn),
      String(step),
      String(addedAsUser),
      asUserAt.join(','),
    )
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

  ctx.on('agent/pre-step', async (payload, next) => {
    // An agent that predates this mount has no wrapped claim yet: its current
    // batch is repaired here, and hooking it covers every later turn. The
    // pending sweep runs first, because the modules that index the pending lists
    // directly read them after their own `next()` — so a value injected into
    // `next-step` mid-turn has to be gone from the projection by then.
    sanitizePending(payload.agent)
    sanitize(payload.messages, 'claimed', String(payload.agent.session.id), null, null)
    hook(payload.agent)
    // Snapshot the claim before `next()`: the fallback continuation returns a
    // new array (`[...claimed, context]`), so the claim's own members are what an
    // addition is measured against. This and the audit below are the whole of
    // the assembly half — the batch itself is never changed by it.
    const claimed = payload.messages.slice()
    const decision = await next()
    try {
      auditStep(payload.agent, claimed, payload.turn, payload.step, decision)
    } catch (error: unknown) {
      // Fail open. An audit that can break a turn is worse than no audit: the
      // failure is counted, and the loop's own decision is handed back untouched.
      assemblyTotals.errors += 1
    }
    return decision
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
    assembly: (): readonly AssemblyRecord[] => assemblyRecords.slice(),
    assemblyCounts: (): AssemblyCounts => ({ ...assemblyTotals }),
    reset: (): void => {
      violations.length = 0
      counts.repaired = 0
      counts.quarantined = 0
      counts.observed = 0
      assemblyRecords.length = 0
      assemblyTotals.steps = 0
      assemblyTotals.anomalous = 0
      assemblyTotals.errors = 0
    },
  } satisfies InboxInputGuardApi)

  ctx.effect(() => () => {
    for (const agent of [...wrapped.keys()]) restore(agent)
  }, 'inbox-input-guard.unwrap()')
}

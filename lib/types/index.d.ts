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
import type { Context } from '@deepseek-ai/cordis';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import z from '@deepseek-ai/schemastery';
export declare const name = "inbox-input-guard";
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
            kind: 'inbox-input-guard';
            plugin?: string;
            form?: 'notice';
            summary?: string;
        };
    }
}
/** Core events and the agent's own inbox are all this plugin reaches. */
export declare const inject: readonly string[];
/** Service name exposing what this mount saw. */
export declare const API_NAME = "inboxInputGuard";
/** What the guard may do with an entry that is not a usable user message. */
export type GuardMode = 'repair' | 'quarantine' | 'report';
/** Where a violation was seen: committed to the log, still pending, or claimed. */
export type ViolationOrigin = 'durable' | 'pending' | 'claimed';
/** What the guard did about it. `observed` is also what the durable half does. */
export type ViolationAction = 'repaired' | 'quarantined' | 'observed';
/** Deployment configuration. */
export interface Config {
    /**
     * `repair` delivers a scalar verbatim and drops anything else;
     * `quarantine` drops every non-message; `report` changes nothing.
     */
    readonly mode?: GuardMode;
    /** Characters of the offending value kept in a record and in the log line. */
    readonly previewChars?: number;
}
export declare const Config: z<Config>;
/** One inbox entry the guard would not hand to the loop unchanged. */
export interface InboxViolation {
    /** Epoch milliseconds at which the guard saw it. */
    readonly at: number;
    readonly origin: ViolationOrigin;
    /** Session whose pending input this was. */
    readonly sessionId: string;
    /** Durable `agent/inbox/spliced` position, when the violation was seen in the log. */
    readonly seq: number | null;
    /** Inbox list or claim target the entry sat in. */
    readonly target: string | null;
    /** Position inside that list, or inside the claimed batch. */
    readonly index: number;
    /** Runtime kind of the offending value. */
    readonly valueKind: string;
    /** Bounded, single-line rendering of the value. */
    readonly preview: string;
    readonly action: ViolationAction;
}
/** The guard's read surface, reachable as `ctx.get('inboxInputGuard')`. */
export interface InboxInputGuardApi {
    /** Every violation this mount saw, oldest first. */
    violations(): readonly InboxViolation[];
    /** Per-action totals for this mount. */
    counts(): Readonly<Record<ViolationAction, number>>;
    /** Drop the records; hooks stay installed. */
    reset(): void;
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
export declare function isUsableUserMessage(value: unknown): value is UserMessage;
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
export declare function apply(ctx: Context, config?: Config): void;

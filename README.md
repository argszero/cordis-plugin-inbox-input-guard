# @argszero/cordis-plugin-inbox-input-guard

**Stop one bad inbox entry from killing the turn it lands in.**

A [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) plugin.
Source discussion: [#7363 — `Cannot read properties of undefined (reading 'kind')`
when a plugin calls `agent.followup()` with a bare string](https://github.com/deepseek-ai/deepseek-harness/discussions/7363).

```sh
npm install @argszero/cordis-plugin-inbox-input-guard
```

## The gap

`agent.followup()`, `agent.steer()` and `agent.inject()` take a message and put
it in the agent's durable inbox. On the path from the call to the log nothing
looks at what was passed: the inbox appends an `agent/inbox/spliced` record and
the value travels on unchanged. The only structural check at that boundary is a
duplicate-identity guard, and what it reads is `message.id` — `undefined` for a
string, `undefined` for a number, `undefined` for anything that is not a
message, so a lone `'some string'` walks straight through.

The next turn claims that entry and hands the batch to every `agent/pre-step`
listener. The first one that reads `message.source.kind` — the shipped
`dsh-time-context` browser-zone reader does exactly that — throws:

```
Cannot read properties of undefined (reading 'kind')
```

The turn ends about a millisecond after `turn/start`, before any `step/start`,
and the report is filed against `time-context`: a module that never saw the
plugin that wrote the string. Nothing in the session names the actual mistake.

## What this plugin does

Three halves, each independently useful:

1. **At the claim.** For every agent it can reach — through `agent/created`, and
   through the first `agent/pre-step` of an agent that predates the mount — it
   wraps `agent.inbox.claim()`. The batch is sanitized before the waterfall
   starts, so **no listener order can matter**: every reader, whenever it runs,
   is handed messages.
2. **At the pre-step entry.** A batch claimed before the mount is repaired in
   place at the guard's own entry point.
3. **At the durable write.** A `session/event` observer records every
   non-message that reaches `agent/inbox/spliced`, with the session, the log
   seq, the inbox list and a bounded rendering — the signal the report above did
   not have. The defect is named where it is committed, instead of surfacing
   later as a crash in an unrelated module.

### Modes

| mode | a scalar (`string` / `number` / `boolean` / `bigint`) | anything else |
|------|------------------------------------------------------|---------------|
| `repair` (default) | delivered **verbatim** as a user message whose source records the repair | dropped from the batch |
| `quarantine` | dropped from the batch | dropped from the batch |
| `report` | untouched — the turn fails exactly as it would without the plugin | untouched |

In `repair` mode the producer's own text still reaches the model, in a message
that reads as:

```json
{
  "role": "user",
  "content": [{ "type": "text", "text": "a bare string from a plugin" }],
  "source": {
    "kind": "plugin",
    "plugin": "inbox-input-guard",
    "form": "notice",
    "summary": "repaired inbox input (string)"
  }
}
```

A value the guard cannot render unambiguously is never turned into content:
forwarding a half-shaped object would push `role: undefined` at the provider,
which is a different failure rather than a fix.

### Reading what it saw

```js
const guard = ctx.get('inboxInputGuard')
guard.violations()  // [{ at, origin, sessionId, seq, target, index, valueKind, preview, action }, …]
guard.counts()      // { repaired, quarantined, observed }
guard.reset()       // drop the records; the hooks stay installed
```

Each violation is also logged at warn level, naming the session and the log seq.

## Honest boundaries

- The durable `agent/inbox/spliced` record keeps whatever was spliced — a plugin
  cannot rewrite committed session history. This guard is the consumer-side half.
- It cannot name the plugin that wrote the string: the inbox records a value, and
  a value does not carry a caller.
- `report` mode re-observes the same untouched entry once per pass, so one bad
  entry appears twice there (at the claim and at the entry). That is the mode
  doing exactly what it says.

The upstream fix is a shape check at the inbox write boundary, plus a check in
`inboxProjectionSchema`, whose `z.custom<UserMessage>()` accepts any value on
replay. Until that lands this plugin keeps a session usable.

## Notes from the write path

Worth knowing if you are writing the upstream check, because the boundary is
narrower and stranger than it looks:

- Values for which `value.id` **throws** (`null`, `undefined`) never reach a
  reader — the identity guard rejects them by accident, with a `TypeError` that
  names neither the value nor the inbox.
- Any two id-less entries in one splice collide on `undefined` and are rejected
  with `message "undefined" is already pending` — so at most one bare scalar can
  be pending at a time.
- An object that carries a unique `id` but no `role`/`content`/`source` passes
  both checks, and several can pile up.

## Install

```sh
npm install @argszero/cordis-plugin-inbox-input-guard
```

It declares `dsh.bundle.patch`, so a profile that picks it up mounts it with no
config. Both mount spellings work: a loader that hands over the module namespace
gets the `Config` defaults through Cordis, and `ctx.plugin({ name, inject,
apply })` — no `Config` for Cordis to resolve — is handled by `apply` itself. Or add it to a bundle's `cordis.patch.yml`:

```yaml
- insert:
    - id: inbox-input-guard
      name: '@argszero/cordis-plugin-inbox-input-guard'
```

## Tests

```sh
npm test
```

Real Cordis, the real `AgentLoop`, a production agent with its real durable
inbox, and the real `time-context` reader the report names. The suite includes a
control arm that reproduces the reported crash with the plugin unmounted, and 16
mutations of the built output, each of which turns the suite red.

`scripts/probe-installed.mjs` is the other half: it imports the *published*
package by name from a directory where it was installed from the registry, and
runs both arms there — because `npm test` resolves through `../lib/` and cannot
see a runtime import the manifest never declared.

MIT.

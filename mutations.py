"""Mutation harness for cordis-plugin-inbox-input-guard.

Each mutation breaks one claim the whole suite (`test/*.spec.mjs`) makes, in the
BUILT output (never in `src/`), and the suite must go red. A mutation whose suite stays green is a claim
that no test actually holds.

Anchors are taken from the built text so that a mutation always lands on code the
suite genuinely reaches; a mutation that silently matches nothing reports
ANCHOR-MISS instead of masquerading as a passing check.
"""
import os
import shutil
import subprocess

ROOT = '/var/folders/s6/15ymxxk93s30yr581vzzzjy40000gn/T/c498/cordis-plugin-inbox-input-guard'
LIB = os.path.join(ROOT, 'lib/index.js')
BACKUP = os.path.join(ROOT, 'lib/index.js.orig')
NODE = '/Users/argszero/.installs/nodejs/26.5.0/bin/node'
NODE = '/Users/argszero/.asdf/installs/nodejs/26.5.0/bin/node'

MUTATIONS = [
    ('the message test accepts anything: shape validation is dropped',
     '    if (typeof value !== \'object\' || value === null)\n        return false;',
     '    return true;'),
    ('only the crash-relevant half is checked: a message with no role or content passes',
     '    if (typeof candidate.id !== \'string\' || candidate.id.length === 0)\n        return false;\n    if (candidate.role !== \'user\')\n        return false;\n    if (!Array.isArray(candidate.content))\n        return false;',
     '    if (typeof candidate.source !== \'object\' || candidate.source === null)\n        return false;'),
    ('the claim is never sanitized: only the pre-step entry is',
     '            const batch = original.call(inbox, target, turn);\n            sanitize(batch, \'claimed\', sessionId, null, String(target));\n            return batch;',
     '            return original.call(inbox, target, turn);'),
    ('a scalar is no longer delivered verbatim: it is dropped instead',
     '            const text = mode === \'repair\' ? verbatimText(value) : undefined;',
     '            const text = undefined;'),
    ('the guard fabricates content for values it cannot render',
     '            const text = mode === \'repair\' ? verbatimText(value) : undefined;',
     '            const text = mode === \'repair\' ? JSON.stringify(value) : undefined;'),
    ('report mode stops observing what it left alone',
     '            if (mode === \'report\') {',
     '            if (false) {'),
    ('quarantine removes nothing: the batch keeps the non-message',
     '            batch.splice(index, 1);',
     '            batch.splice(index, 1, value);'),
    ('the repair is no longer recorded in the message source',
     '                summary: boundContextSummary(`repaired inbox input (${violation.valueKind})`)',
     '                summary: boundContextSummary(`inbox input`)'),
    ('the durable half ignores the write that starts the defect',
     '        if (event.type !== \'agent/inbox/spliced\')\n            return;',
     '        if (true)\n            return;'),
    ('the entry hook never runs: an agent that predates the mount stays unhooked',
     '        sanitize(payload.messages, \'claimed\', String(payload.agent.session.id), null, null);\n        hook(payload.agent);',
     '        void payload;'),
    ('the hook is not idempotent: every pre-step stacks another wrapper',
     '        if (wrapped.has(agent))\n            return;',
     '        if (false)\n            return;'),
    ('unmount leaves the wrapper in place',
     '        if (entry.hadOwn)\n            holder[\'claim\'] = entry.original;\n        else\n            delete holder[\'claim\'];',
     '        void entry;'),
    ('unmount always deletes, discarding a shadow that was already there',
     '        if (entry.hadOwn)\n            holder[\'claim\'] = entry.original;\n        else\n            delete holder[\'claim\'];',
     '        delete holder[\'claim\'];'),
    ('the guard no longer records what it did',
     '    const record = (violation) => {\n        violations.push(violation);\n        counts[violation.action] += 1;',
     '    const record = (violation) => {\n        violations.push(violation);'),
    ('previewChars is ignored: every record carries the whole value',
     '    return single.length <= max ? single : `${single.slice(0, max)}…`;',
     '    return single;'),
]


def run_suite():
    completed = subprocess.run(
        [NODE, '--test', '--test-timeout=20000', 'test/*.spec.mjs'],
        cwd=ROOT, capture_output=True, text=True, timeout=900,
    )
    output = completed.stdout + completed.stderr
    passed = [line for line in output.splitlines() if line.startswith('\u2714')]
    failed = [line for line in output.splitlines() if line.startswith('\u2716')]
    return completed.returncode, len(passed), len(failed), output


def main():
    shutil.copy2(LIB, BACKUP)
    original = open(LIB, encoding='utf-8').read()
    results = []
    try:
        for label, anchor, replacement in MUTATIONS:
            if anchor not in original:
                results.append((label, 'ANCHOR-MISS', 'the anchor is not in the built text'))
                print(f'{"ANCHOR-MISS":18} {label}', flush=True)
                continue
            open(LIB, 'w', encoding='utf-8').write(original.replace(anchor, replacement, 1))
            code, passed, failed, output = run_suite()
            verdict = 'RED' if (code != 0 and failed > 0) else 'GREEN (survivor!)'
            names = [line.strip()[:96] for line in output.splitlines() if line.startswith('\u2716')]
            results.append((label, verdict, f'{failed} failing / {passed} passing; first: {names[0] if names else "none"}'))
            print(f'{verdict:18} {label}\n{"":18} {results[-1][2]}', flush=True)
    finally:
        open(LIB, 'w', encoding='utf-8').write(original)
    survivors = [r for r in results if 'GREEN' in r[1] or 'ANCHOR' in r[1]]
    print(f'\n{len(results) - len(survivors)}/{len(results)} mutations RED, {len(survivors)} survivors')
    for label, verdict, detail in survivors:
        print(f'  {verdict}: {label} — {detail}')
    return 1 if survivors else 0


if __name__ == '__main__':
    raise SystemExit(main())

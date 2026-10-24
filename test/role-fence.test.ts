/**
 * The role fence (core/teams/fence.ts): a read-only session is refused file
 * tools and any Bash that writes, whatever the user's allow rules say — the
 * hook runs before them. A writer passes everything to the Actions hold.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bashWrites, redirectTargets, roleFenceDecision, type RoleFence } from '../core/teams/fence.js'
import { roleWrites } from '../core/teams/writes.js'

const reviewer: RoleFence = { write: false, role: 'reviewer' }
const builder: RoleFence = { write: true, role: 'implementer' }
const bash = (command: string) => roleFenceDecision(reviewer, 'Bash', { command })

test('a read-only role may not use the file tools', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    const d = roleFenceDecision(reviewer, tool, { file_path: '/tmp/x', content: 'hi' })
    assert.equal(d.allow, false, tool)
    assert.match(!d.allow ? d.reason : '', /read-only reviewer may not change files/)
  }
  assert.deepEqual(roleFenceDecision(reviewer, 'Read', { file_path: '/tmp/x' }), { allow: true })
  assert.deepEqual(roleFenceDecision(reviewer, 'Grep', { pattern: 'x' }), { allow: true })
})

test('Bash that writes a file is refused: redirects, also inside bash -c and eval', () => {
  for (const cmd of [
    'echo hi > /tmp/x',
    'echo hi >> /tmp/x',
    'npm test 2>&1 | cat > out.log',
    'bash -c "echo hi > /tmp/x"',
    "sh -c 'cat a >/tmp/b'",
    'eval "echo > /tmp/x"',
    'echo hi >| /tmp/x',
    'cat a &> /tmp/all',
  ]) {
    const d = bash(cmd)
    assert.equal(d.allow, false, cmd)
    assert.match(!d.allow ? d.reason : '', /Report what should change instead/)
  }
  assert.deepEqual(redirectTargets('echo "a" > "/tmp/my file"'), ['/tmp/my file'])
})

test('Bash that changes files, processes, the repo or packages is refused', () => {
  for (const cmd of [
    'pkill node',
    'kill -9 123',
    'rm -rf dist',
    'mkdir -p /tmp/scratch',
    'mktemp',
    'touch a && cat a',
    'cat a | tee b',
    'git commit -m x',
    'git -C repo push',
    'git stash',
    'git checkout -- .',
    'git branch new-thing',
    'npm install left-pad',
    'npm i',
    'sed -i "" s/a/b/ f',
    'curl -o out https://x',
    'find . -name "*.tmp" -delete',
    'find . -exec rm {} \;',
    'ls | xargs rm',
    'cd sub && rm a',
    // Substitutions run their script, quoted or not.
    'echo $(touch /tmp/a)',
    'x=$(touch /tmp/a)',
    'echo "$(touch /tmp/a)"',
    'echo `rm x`',
    'echo "`rm x`"',
    'cat <(rm x)',
    'diff <(ls) <(git stash)',
    'echo "$(echo hi > /tmp/x)"',
    'echo "$(bash -c \'touch /tmp/a\')"',
    // Reserved words lead into the real command.
    'for f in a; do rm $f; done',
    'if true; then rm x; fi',
    'if ! mkdir d; then echo no; else touch y; fi',
    'while read l; do kill $l; done < pids',
    'case $x in a) rm x;; esac',
    '{ touch a; }',
  ]) {
    assert.equal(bash(cmd).allow, false, cmd)
  }
})

test('read-only Bash passes', () => {
  for (const cmd of [
    'cat a',
    'npm test 2>&1',
    'npm run typecheck 2>&1 | tail -20',
    'grep "a>b" f',
    "grep 'x > y' -r src",
    'cmd > /dev/null 2>&1',
    'echo hi >&2',
    'git status && git diff --stat',
    'git log --oneline -5',
    'git branch',
    'git branch --show-current',
    'git config --get user.name',
    'git stash list',
    'ls -la # writes > nothing',
    'sed -n 1,20p f',
    'find . -name "*.ts"',
    'npm ls',
    'curl -s https://example.com',
    'echo $(git rev-parse HEAD)',
    'echo "branch: `git branch --show-current`"',
    'diff <(sort a) <(sort b)',
    'echo $(( 3 > 2 ))',
    "echo '$(rm x)'",
    'for f in *.ts; do wc -l $f; done',
    'if [ -f a ]; then cat a; fi',
  ]) {
    assert.deepEqual(bash(cmd), { allow: true }, cmd)
    assert.equal(bashWrites(cmd), null, cmd)
  }
})

test('a writer passes everything — the hold decides outbound next', () => {
  assert.deepEqual(roleFenceDecision(builder, 'Write', { file_path: '/tmp/x' }), { allow: true })
  assert.deepEqual(roleFenceDecision(builder, 'Bash', { command: 'rm -rf dist > /tmp/log' }), { allow: true })
  assert.deepEqual(roleFenceDecision(builder, 'Bash', { command: 'git push' }), { allow: true })
})

test('the role names itself in the refusal', () => {
  const d = roleFenceDecision({ write: false, role: 'brief' }, 'Bash', { command: 'touch x' })
  assert.match(!d.allow ? d.reason : '', /^a read-only brief may not change files or processes: `touch` changes files/)
})

test('an independent reviewer may not read the goal ledger or session transcripts, by any tool', () => {
  const f: RoleFence = { write: false, role: 'reviewer', hidden: ['/ws/artifacts/goals/g1', '/.claude/projects/'] }
  for (const [tool, input] of [
    ['Read', { file_path: '/ws/artifacts/goals/g1/handoff.md' }],
    ['Grep', { pattern: 'x', path: '/ws/artifacts/goals/g1' }],
    ['Bash', { command: 'cat /ws/artifacts/goals/g1/log.md' }],
    ['Read', { file_path: '/Users/me/.claude/projects/-repo/abc.jsonl' }],
  ] as const) {
    const d = roleFenceDecision(f, tool, input)
    assert.equal(d.allow, false, `${tool} ${JSON.stringify(input)}`)
    assert.match(!d.allow ? d.reason : '', /reviews independently/)
  }
  assert.deepEqual(roleFenceDecision(f, 'Read', { file_path: '/repo/src/parser.ts' }), { allow: true })
  assert.deepEqual(roleFenceDecision(f, 'Bash', { command: 'git diff main...HEAD' }), { allow: true })
})

test('roleWrites: only a builder changes files', () => {
  assert.equal(roleWrites('builder'), true)
  for (const r of ['lead', 'reviewer', 'tester'] as const) assert.equal(roleWrites(r), false, r)
})

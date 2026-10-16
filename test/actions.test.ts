/**
 * Actions, phase 1 (spec 7ce2f076): how a tool call is sorted, the actions
 * file, where an action landed, and the fold from a session's event log into
 * records — live and backfilled alike, so a backfill run twice must change
 * nothing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { matchPart, parsePattern, pushTarget, splitCommand, type BashPattern } from '../core/actions/bash.js'
import { DEFAULT_ACTIONS_FILE, DEFAULT_RULES, parseActionsFile, withOverride, type ActionRules } from '../core/actions/rules.js'
import { bashPatternsOf, describeTool, kindOfTool, overriddenOff, sortCall, withRowOverride } from '../core/actions/sort.js'
import { ActionsFile } from '../server/actions-file.js'
import { readFileSync } from 'node:fs'
import type { ActionRecord } from '../core/actions/types.js'
import { extractLink, pushedBranch, resultText } from '../core/actions/link.js'
import { ActionTracker, applyActionOps, trimArgs, type ActionOp, type TrackContext } from '../core/actions/track.js'
import { countLine, countSince } from '../core/actions/count.js'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { SessionEvent } from '../shared/protocol.js'

const pat = (t: string): BashPattern => {
  const p = parsePattern(t)
  if (typeof p === 'string') throw new Error(p)
  return p
}
const matches = (cmd: string, p: string) => splitCommand(cmd).some((part) => matchPart(part, pat(p)) >= 0)
const sort = (name: string, input: Record<string, unknown> = {}, rules: ActionRules = DEFAULT_RULES, hints?: Parameters<typeof sortCall>[2]['hints']) =>
  sortCall(name, input, { rules, hints })
const bash = (command: string, rules: ActionRules = DEFAULT_RULES) => sort('Bash', { command }, rules)

// ---------------------------------------------------------------------------
// Splitting a command
// ---------------------------------------------------------------------------

test('split: on && || ; | & and newlines, quotes kept whole', () => {
  assert.deepEqual(splitCommand('cd app && git push origin main; echo "a && b" | cat'), [
    ['cd', 'app'],
    ['git', 'push', 'origin', 'main'],
    ['echo', 'a && b'],
    ['cat'],
  ])
  assert.deepEqual(splitCommand("npm test || echo 'failed; ok'\ngit status &"), [['npm', 'test'], ['echo', 'failed; ok'], ['git', 'status']])
})

test('split: a redirection is not a background &', () => {
  assert.deepEqual(splitCommand('gh pr create --fill 2>&1 | tail -1'), [['gh', 'pr', 'create', '--fill', '2>&1'], ['tail', '-1']])
  assert.deepEqual(splitCommand('make &> log.txt'), [['make', '&>', 'log.txt']])
})

test('split: a heredoc body inside $( ) never leaks commands', () => {
  const cmd = `gh pr create --title "Fix it" --body "$(cat <<'EOF'
## Summary
it's done; git push --force && rm -rf /
EOF
)"`
  const parts = splitCommand(cmd)
  // The substitution's own script is opened up — `cat`, and nothing from the heredoc.
  assert.deepEqual(parts.map((p) => p[0]), ['gh', 'cat'])
  assert.deepEqual(parts[0].slice(0, 5), ['gh', 'pr', 'create', '--title', 'Fix it'])
})

test('split: a top-level heredoc is skipped, comments dropped, bash -c opened', () => {
  assert.deepEqual(splitCommand("cat > f <<EOF\ngit push\nEOF\necho done # git push"), [['cat', '>', 'f'], ['echo', 'done']])
  assert.ok(splitCommand(`bash -lc "cd x && git push"`).some((p) => p[0] === 'git'))
})

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

test('patterns: words, alternatives, flags anywhere after', () => {
  assert.ok(matches('gh pr create --fill', 'gh pr create'))
  assert.ok(matches('gh pr review 12 --approve', 'gh pr comment|review'))
  assert.ok(!matches('gh pr view 12', 'gh pr comment|review'))
  assert.ok(matches('gh api repos/o/r/issues -X POST -f title=x', 'gh api -X|--method POST|PATCH'))
  assert.ok(matches('gh api --method=patch repos/o/r', 'gh api -X|--method POST|PATCH'))
  assert.ok(matches('gh api -XPOST repos/o/r', 'gh api -X|--method POST|PATCH'))
  assert.ok(!matches('gh api repos/o/r/pulls', 'gh api -X|--method POST|PATCH'))
  assert.ok(!matches('gh api -X GET repos/o/r', 'gh api -X|--method POST|PATCH'))
  assert.ok(matches('vercel --prod', 'vercel --prod'))
  assert.ok(!matches('vercel ls', 'vercel --prod'))
})

test('patterns: env, wrappers, paths and global flags before the subcommand', () => {
  assert.ok(matches('GH_TOKEN=x gh pr create', 'gh pr create'))
  assert.ok(matches('/opt/homebrew/bin/gh pr create', 'gh pr create'))
  assert.ok(matches('npx --yes vercel deploy', 'vercel deploy'))
  assert.ok(matches('git -C ../app push -u origin feat', 'git push'))
  assert.ok(!matches('git commit -m "git push later"', 'git push'))
  assert.ok(!matches('echo git push', 'git push'))
})

test('patterns: what does not parse says why', () => {
  assert.equal(typeof parsePattern(''), 'string')
  assert.equal(typeof parsePattern('--prod'), 'string')
  assert.equal(typeof parsePattern('gh -X POST api'), 'string')
  assert.equal(typeof parsePattern('gh pr a||b'), 'string')
})

test('push target: the branch a push names, or null for the current one', () => {
  const t = (c: string) => pushTarget(splitCommand(c)[0])
  assert.equal(t('git push origin feat'), 'feat')
  assert.equal(t('git push -u origin HEAD:refs/heads/fix'), 'fix')
  assert.equal(t('git push --force-with-lease origin +main'), 'main')
  assert.equal(t('git push'), null)
  assert.equal(t('git push -u origin HEAD'), null)
})

// ---------------------------------------------------------------------------
// Sorting a tool call
// ---------------------------------------------------------------------------

test('sort: built-ins and triage’s own servers are never actions', () => {
  for (const t of ['Write', 'Edit', 'Read', 'WebFetch', 'TodoWrite', 'Agent']) assert.equal(sort(t, { file_path: '/x' }), null)
  assert.equal(sort('mcp__triage__create_work_item', { title: 'x' }), null)
  assert.equal(sort('mcp__team__submit_step'), null)
  assert.equal(sort('mcp__browser__browser_act'), null)
})

test('sort: annotations first, then name verbs, then unknown', () => {
  assert.equal(sort('mcp__claude_ai_Linear__create_issue', {}, DEFAULT_RULES, { readOnly: true }), null)
  assert.equal(sort('mcp__local__send_thing', {}, DEFAULT_RULES, { openWorld: false }), null)
  assert.deepEqual(
    [sort('mcp__x__search_index', {}, DEFAULT_RULES, { destructive: true })?.why, sort('mcp__x__get_thing', {}, DEFAULT_RULES, { readOnly: false })?.whyDetail],
    ['annotation', 'not read-only'],
  )
  const send = sort('mcp__claude_ai_Slack__slack_send_message', { text: 'hi' })
  assert.equal(send?.why, 'name verb')
  assert.equal(send?.whyDetail, 'send')
  assert.equal(send?.kind, 'message')
  assert.equal(sort('mcp__claude_ai_Slack__slack_read_channel'), null)
  // A write verb beats a read verb in the same name.
  assert.equal(sort('mcp__x__get_or_create_issue')?.why, 'name verb')
  assert.equal(sort('mcp__x__frobnicate')?.why, 'unknown')
})

test('sort: kinds from the tool’s name and server', () => {
  assert.equal(kindOfTool('mcp__claude_ai_Atlassian__createJiraIssue'), 'ticket')
  assert.equal(kindOfTool('mcp__claude_ai_Atlassian__addCommentToJiraIssue'), 'comment')
  assert.equal(kindOfTool('mcp__claude_ai_Gmail__send_email'), 'email')
  assert.equal(kindOfTool('mcp__github__create_pull_request'), 'pr')
  assert.equal(kindOfTool('mcp__typefully__create_draft'), 'other')
  assert.equal(kindOfTool('mcp__x__publish_post'), 'post')
  assert.equal(kindOfTool('mcp__linear__update_issue'), 'update')
  assert.equal(describeTool('mcp__linear__create_issue', { title: 'Broken login', team: 'NOV' }), 'Create issue: Broken login')
})

test('sort: Bash counts only what matches the list; the headline kind wins', () => {
  assert.equal(bash('npm test && git commit -m x'), null)
  const pr = bash('git push -u origin feat && gh pr create --title "Fix login" --body x')
  assert.equal(pr?.kind, 'pr')
  assert.equal(pr?.why, 'bash pattern')
  assert.equal(pr?.whyDetail, 'git push !--dry-run|-n, gh pr create')
  assert.equal(pr?.summary, 'gh pr create: Fix login')
  const push = bash('git push origin feat')
  assert.equal(push?.kind, 'push')
  assert.equal(push?.pushBranch, 'feat')
  assert.equal(bash('git push')?.pushBranch, '')
  assert.equal(bash('gh pr comment 12 --body "lgtm"')?.summary, 'gh pr comment 12')
})

test('sort: overrides — exact beats wildcard, Bash(…) both ways', () => {
  const rules: ActionRules = {
    ...DEFAULT_RULES,
    action: ['mcp__chrome-devtools__navigate_page', 'Bash(make deploy)'],
    notAction: [...DEFAULT_RULES.notAction, 'mcp__x__send_thing', 'Bash(git push)'],
  }
  assert.equal(sort('mcp__chrome-devtools__click', {}, rules), null)
  assert.equal(sort('mcp__chrome-devtools__navigate_page', {}, rules)?.why, 'override')
  assert.equal(sort('mcp__x__send_thing', {}, rules), null)
  assert.equal(bash('git push origin main', rules), null)
  assert.equal(bash('make deploy', rules)?.why, 'override')
  assert.ok(overriddenOff({ tool: 'Bash', whyDetail: 'git push' }, rules))
  assert.ok(overriddenOff({ tool: 'mcp__chrome-devtools__click', whyDetail: null }, rules))
  assert.ok(!overriddenOff({ tool: 'mcp__chrome-devtools__navigate_page', whyDetail: null }, rules))
})

// ---------------------------------------------------------------------------
// The actions file
// ---------------------------------------------------------------------------

test('actions file: the default parses clean', () => {
  const { rules, errors } = parseActionsFile(DEFAULT_ACTIONS_FILE)
  assert.deepEqual(errors, [])
  assert.ok(rules.bash.some((b) => b.kind === 'push' && b.pattern.text === 'git push !--dry-run|-n'))
  assert.ok(rules.notAction.includes('mcp__chrome-devtools__*'))
})

test('actions file: strict — unknown keys, kinds, patterns and entries are errors', () => {
  const bad = parseActionsFile('---\nbash:\n  pr: [gh pr create]\n  tweets: [x post]\n  push: ["--force"]\naction: [notatool]\ncolour: red\n---\n')
  assert.deepEqual(
    bad.errors.map((e) => e.replace(/".*?"/g, '"…"')).sort(),
    ['action: "…" is not a tool name (mcp__…) or Bash(…)', 'bash.push: --force: a pattern starts with the command', 'bash: unknown kind "…"', 'unknown key "…" (expected bash, action, not_action)'].sort(),
  )
  assert.ok(bad.rules.bash.some((b) => b.kind === 'pr'))
  assert.deepEqual(parseActionsFile('no frontmatter').errors.length, 1)
})

test('actions file: overrides edit the text in place', () => {
  let t = withOverride(DEFAULT_ACTIONS_FILE, 'action', 'mcp__x__y', true)
  assert.match(t, /^action:\n {2}- "mcp__x__y"$/m)
  assert.ok(t.includes('# Browsers and editors on this machine'))
  t = withOverride(t, 'not_action', 'Bash(git push)', true)
  t = withOverride(t, 'not_action', 'Bash(git push)', true) // twice = once
  assert.equal(t.split('Bash(git push)').length, 2)
  const parsed = parseActionsFile(t)
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.rules.action, ['mcp__x__y'])
  assert.ok(parsed.rules.notAction.includes('Bash(git push)'))
  t = withOverride(t, 'action', 'mcp__x__y', false)
  assert.match(t, /^action: \[\]$/m)
  t = withOverride(t, 'not_action', 'Bash(git push)', false)
  assert.ok(!t.includes('Bash(git push)'))
  assert.deepEqual(parseActionsFile(t).rules, DEFAULT_RULES)
})

// ---------------------------------------------------------------------------
// Where it landed
// ---------------------------------------------------------------------------

const PUSH_OUT = `remote:
remote: Create a pull request for 'feat' on GitHub by visiting:
remote:      https://github.com/acme/app/pull/new/feat
remote:
To github.com:acme/app.git
 * [new branch]      feat -> feat
branch 'feat' set up to track 'origin/feat'.`

test('links: gh output, a push, connector JSON, then the first URL', () => {
  assert.equal(extractLink('Creating pull request for feat into main\n\nhttps://github.com/acme/app/pull/42\n'), 'https://github.com/acme/app/pull/42')
  assert.equal(extractLink('https://github.com/acme/app/pull/42#issuecomment-99'), 'https://github.com/acme/app/pull/42#issuecomment-99')
  assert.equal(extractLink(PUSH_OUT, { push: true }), 'https://github.com/acme/app/tree/feat')
  assert.equal(pushedBranch(PUSH_OUT), 'feat')
  assert.equal(pushedBranch('To github.com:acme/app.git\n   1a2b3c4..5d6e7f8  main -> main'), 'main')
  assert.equal(pushedBranch('Everything up-to-date'), null)
  assert.equal(extractLink('{"id":"x","identifier":"NOV-12","url":"https://linear.app/acme/issue/NOV-12/broken"}'), 'https://linear.app/acme/issue/NOV-12/broken')
  assert.equal(extractLink('{"ok":true,"message":{"permalink":"https://acme.slack.com/archives/C1/p2"}}'), 'https://acme.slack.com/archives/C1/p2')
  assert.equal(extractLink('Done. See https://example.com/a/b.'), 'https://example.com/a/b')
  assert.equal(extractLink('no links here'), null)
  assert.equal(resultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
})

// ---------------------------------------------------------------------------
// The fold: events → records
// ---------------------------------------------------------------------------

const ctx = (over: Partial<TrackContext> = {}): TrackContext => ({
  sessionId: 's1',
  sessionKind: 'chat',
  permissionMode: null,
  jobId: null,
  teamRunId: null,
  itemId: null,
  ...over,
})
const tracker = (over: Partial<TrackContext> = {}) => new ActionTracker(ctx(over), (n, i) => sortCall(n, i, { rules: DEFAULT_RULES }))
const use = (id: string, name: string, input: Record<string, unknown>): SessionEvent => ({
  kind: 'sdk',
  message: { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } },
})
const result = (id: string, content: unknown, isError = false): SessionEvent => ({
  kind: 'sdk',
  message: { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } },
})
const ask = (id: string, toolName: string, input: Record<string, unknown>, toolUseId?: string): SessionEvent => ({
  kind: 'permission_request',
  id,
  toolName,
  input,
  ...(toolUseId ? { toolUseId } : {}),
})
const answer = (id: string, behavior: 'allow' | 'allow_always' | 'deny' | 'expired'): SessionEvent => ({ kind: 'permission_resolved', id, behavior })

test('fold: a PR via Bash — attempted, then succeeded with its link; reads are ignored', () => {
  const t = tracker({ permissionMode: 'bypassPermissions', itemId: 'github:acme/app#7' })
  assert.deepEqual(t.feed(use('r1', 'Read', { file_path: '/x' }), 1), [])
  const [a] = t.feed(use('t1', 'Bash', { command: 'gh pr create --title "Fix login" --fill' }), 10)
  assert.equal(a.op, 'attempt')
  assert.equal(a.op === 'attempt' && a.record.status, 'attempted')
  assert.equal(a.op === 'attempt' && a.record.id, 's1:t1')
  assert.equal(a.op === 'attempt' && a.record.itemId, 'github:acme/app#7')
  const [s] = t.feed(result('t1', 'https://github.com/acme/app/pull/42\n'), 20)
  assert.deepEqual(s.op === 'settle' && s.patch, {
    status: 'succeeded',
    link: 'https://github.com/acme/app/pull/42',
    error: null,
    allowedBy: 'mode',
    allowedDetail: 'bypass permissions',
    settledAt: 20,
  })
})

test('fold: who allowed it — your prompt, a job’s grants, a rule; a denial is denied', () => {
  const send = { channel: 'C1', text: 'shipped' }
  const tool = 'mcp__claude_ai_Slack__slack_send_message'
  // Prompt after the call, matched by input (older logs carry no toolUseId).
  let t = tracker()
  t.feed(use('t1', tool, send), 1)
  t.feed(ask('p1', tool, { text: 'shipped', channel: 'C1' }), 2)
  t.feed(answer('p1', 'allow_always'), 3)
  let [s] = t.feed(result('t1', '{"ok":true}'), 4)
  assert.equal(s.op === 'settle' && s.patch.allowedBy, 'prompt')
  assert.equal(s.op === 'settle' && s.patch.allowedDetail, 'always, for this session')
  // Prompt before the call, matched by its id.
  t = tracker()
  t.feed(ask('p2', tool, send, 't2'), 1)
  t.feed(use('t2', tool, send), 2)
  ;[s] = t.feed(answer('p2', 'deny'), 3)
  assert.equal(s.op === 'settle' && s.patch.status, 'denied')
  assert.equal(s.op === 'settle' && s.patch.allowedBy, null)
  // The result that follows a denial changes nothing more.
  assert.deepEqual(t.feed(result('t2', 'Denied by the user in the triage web UI.', true), 4), [])
  // A job run's grants; a plain chat's allow rule; a failure is a failure.
  t = tracker({ sessionKind: 'job-run', jobId: 'w1' })
  t.feed(use('t3', tool, send), 1)
  ;[s] = t.feed(result('t3', 'ok'), 2)
  assert.equal(s.op === 'settle' && s.patch.allowedBy, 'rule')
  t = tracker()
  t.feed(use('t4', 'Bash', { command: 'git push' }), 1)
  ;[s] = t.feed(result('t4', 'remote: Permission to acme/app.git denied to bot.', true), 2)
  assert.equal(s.op === 'settle' && s.patch.status, 'failed')
  // A job fence refusal reads as denied.
  t = tracker({ sessionKind: 'job-run' })
  t.feed(use('t5', tool, send), 1)
  ;[s] = t.feed(result('t5', `${tool} is not granted to this job`, true), 2)
  assert.equal(s.op === 'settle' && s.patch.status, 'denied')
})

test('fold: an expired prompt settles as denied at once', () => {
  const t = tracker()
  t.feed(use('t1', 'Bash', { command: 'gh issue create -t Bug' }), 1)
  t.feed(ask('p1', 'Bash', { command: 'gh issue create -t Bug' }, 't1'), 2)
  const [s] = t.feed(answer('p1', 'expired'), 3)
  assert.equal(s.op === 'settle' && s.patch.status, 'denied')
  assert.match((s.op === 'settle' && s.patch.error) || '', /session ended/)
})

test('trimArgs: long strings clipped, shape kept', () => {
  const out = trimArgs({ body: 'x'.repeat(5000), n: 3, nested: { list: ['a', 'b'] } }, 100)
  assert.match(String(out.body), /^x{100}… \(5000 chars\)$/)
  assert.deepEqual(out.nested, { list: ['a', 'b'] })
})

// ---------------------------------------------------------------------------
// Applying to the store: collapse, merge, idempotent backfill
// ---------------------------------------------------------------------------

function freshStore() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'triage-actions-'))
  return openSqliteStore(path.join(dir, 'triage.db'))
}

/** A session's log with: a PR, two pushes to one branch (one bare), a denied comment, and noise. */
const LOG: Array<[SessionEvent, number]> = [
  [use('a', 'Read', { file_path: '/x' }), 1],
  [use('b', 'Bash', { command: 'git push -u origin feat' }), 2],
  [result('b', PUSH_OUT), 3],
  [use('c', 'Bash', { command: 'gh pr create --title "Fix login" --fill' }), 4],
  [result('c', 'https://github.com/acme/app/pull/42'), 5],
  [use('d', 'Bash', { command: 'git push' }), 6],
  [result('d', 'To github.com:acme/app.git\n   1a2b3c4..5d6e7f8  feat -> feat'), 7],
  [use('e', 'Bash', { command: 'gh pr comment 42 --body hi' }), 8],
  [ask('p', 'Bash', { command: 'gh pr comment 42 --body hi' }, 'e'), 9],
  [answer('p', 'deny'), 10],
  [result('e', 'Denied by the user in the triage web UI.', true), 11],
]

async function backfill(store: ReturnType<typeof freshStore>): Promise<void> {
  const t = tracker()
  const ops: ActionOp[] = LOG.flatMap(([ev, at]) => t.feed(ev, at))
  await applyActionOps(store.actions, ops)
}

test('store: pushes collapse per branch, a bare push joins its branch on the result', async () => {
  const store = freshStore()
  await backfill(store)
  const all = await store.actions.list()
  assert.deepEqual(
    all.map((a) => [a.kind, a.status, a.count]),
    [
      ['comment', 'denied', 1],
      ['pr', 'succeeded', 1],
      ['push', 'succeeded', 2],
    ],
  )
  const push = all.find((a) => a.kind === 'push')!
  assert.equal(push.groupKey, 'push:s1:feat')
  assert.deepEqual(push.calls, ['b', 'd'])
  assert.equal(push.link, 'https://github.com/acme/app/tree/feat')
  assert.equal((await store.actions.byCall('s1', 'd'))?.id, push.id)
  await store.close()
})

test('store: a backfill run twice changes nothing', async () => {
  const store = freshStore()
  await backfill(store)
  const once = await store.actions.list()
  await backfill(store)
  assert.deepEqual(await store.actions.list(), once)
  assert.deepEqual(
    (await store.actions.list({ kind: 'pr' })).map((a) => a.id),
    ['s1:c'],
  )
  assert.deepEqual((await store.actions.list({ itemId: 'nope', sessionIds: ['s1'] })).length, 3)
  await store.close()
})

// ---------------------------------------------------------------------------
// The daily line
// ---------------------------------------------------------------------------

test('count line: what went out today, in the kinds’ order', () => {
  const r = (kind: Parameters<typeof countSince>[0][number]['kind'], status: 'succeeded' | 'failed' | 'attempted' = 'succeeded', count = 1, attemptedAt = 100) => ({ kind, status, count, attemptedAt })
  const counts = countSince([r('comment'), r('pr'), r('comment'), r('ticket'), r('post'), r('comment', 'failed'), r('pr', 'succeeded', 1, 5), r('push', 'succeeded', 3), r('push', 'attempted', 2)], 50)
  // Only what went out: a call still waiting on its result doesn't count yet.
  assert.equal(countLine(counts), 'Today: 1 PR, 2 comments, 1 ticket, 1 post, 3 pushes')
  assert.equal(countLine([]), 'Today: nothing has gone out yet')
})

// ---------------------------------------------------------------------------
// Regressions from the validator's review
// ---------------------------------------------------------------------------

/** Claude's usual commit-and-push: a long heredoc message, then the push. */
const LONG_PUSH = `git add -A && git commit -m "$(cat <<'EOF'
Rework the actions ledger

${'A long body line that explains the change in more words than anyone needs. '.repeat(12)}
EOF
)" && git push`

test('fix 1: a long Bash command is stored whole and never set aside by its own clipping', () => {
  assert.ok(LONG_PUSH.length > 700)
  const t = tracker()
  const [a] = t.feed(use('t1', 'Bash', { command: LONG_PUSH, description: 'x'.repeat(2000) }), 1)
  assert.ok(a.op === 'attempt')
  const rec = a.op === 'attempt' ? a.record : (null as unknown as ActionRecord)
  assert.equal(rec.kind, 'push')
  assert.equal(rec.args.command, LONG_PUSH)
  assert.match(String(rec.args.description), /… \(2000 chars\)$/)
  // Even a clipped command can't hide it: the stored pattern decides.
  const clipped = { ...rec, args: trimArgs({ command: LONG_PUSH }, 600) }
  assert.ok(!overriddenOff(clipped, DEFAULT_RULES))
  // Not an action → set aside; This is an action → back, from the patterns alone.
  const off = withRowOverride(DEFAULT_ACTIONS_FILE, clipped, 'not_action')
  assert.ok(overriddenOff(clipped, parseActionsFile(off).rules))
  const on = withRowOverride(off, clipped, 'action')
  assert.ok(!overriddenOff(clipped, parseActionsFile(on).rules))
  assert.deepEqual(parseActionsFile(on).rules, DEFAULT_RULES)
})

test('fix 1: a command counted by two patterns is set aside only when both are', () => {
  const rec = { tool: 'Bash', whyDetail: 'git push !--dry-run|-n, gh pr create', args: {} }
  assert.deepEqual(bashPatternsOf(rec.whyDetail), ['git push !--dry-run|-n', 'gh pr create'])
  const one = withOverride(DEFAULT_ACTIONS_FILE, 'not_action', 'Bash(gh pr create)', true)
  assert.ok(!overriddenOff(rec, parseActionsFile(one).rules))
  assert.ok(overriddenOff(rec, parseActionsFile(withRowOverride(DEFAULT_ACTIONS_FILE, rec, 'not_action')).rules))
})

test('fix 2: a connector’s JSON link wins over a PR quoted in its description', () => {
  const linear = JSON.stringify({
    id: 'abc',
    identifier: 'PX-197',
    description: 'Follow-up to https://github.com/acme/app/pull/88',
    url: 'https://linear.app/acme/issue/PX-197/fix-login',
  })
  assert.equal(extractLink(linear), 'https://linear.app/acme/issue/PX-197/fix-login')
  assert.equal(extractLink(linear, { bash: true }), 'https://linear.app/acme/issue/PX-197/fix-login')
  // Plain connector text: its first URL, not the GitHub one it mentions later.
  assert.equal(
    extractLink('Created PX-197 https://linear.app/acme/issue/PX-197 (see https://github.com/acme/app/pull/88)'),
    'https://linear.app/acme/issue/PX-197',
  )
  // gh output still gets its PR URL.
  assert.equal(extractLink('Warning: 1 uncommitted change\nhttps://github.com/acme/app/pull/42\n', { bash: true }), 'https://github.com/acme/app/pull/42')
})

test('fix 3: gh api with fields posts unless a method says otherwise', () => {
  assert.equal(bash('gh api repos/acme/app/issues/1/labels -f labels[]=bug')?.kind, 'other')
  assert.equal(bash('gh api repos/acme/app/issues --field title=x')?.why, 'bash pattern')
  assert.ok(bash('gh api repos/acme/app/contents/x --input body.json'))
  assert.ok(bash('gh api -Fbody=@f repos/acme/app/issues/1/comments'))
  assert.equal(bash('gh api -X GET repos/acme/app/pulls -f per_page=100'), null)
  assert.equal(bash('gh api --method=get search/issues -f q=x'), null)
  assert.equal(bash('gh api repos/acme/app/pulls'), null)
})

test('fix 4: an unquoted ) ends a command — subshells count', () => {
  assert.deepEqual(splitCommand('(cd app; git push)'), [['cd', 'app'], ['git', 'push']])
  assert.equal(bash('(cd app && git push origin feat)')?.kind, 'push')
  assert.equal(bash('echo "(git push)"'), null)
})

test('fix 5: a dry-run push is not an action', () => {
  assert.equal(bash('git push --dry-run origin feat'), null)
  assert.equal(bash('git push -n'), null)
  assert.equal(bash('git push origin feat')?.kind, 'push')
  assert.equal(typeof parsePattern('git push !word'), 'string')
})

test('fix 6: a push links to its branch or its "open a PR" hint, never remote chatter', () => {
  const dependabot =
    'remote: GitHub found 3 vulnerabilities on acme/app. To find out more, visit:\nremote:      https://github.com/acme/app/security/dependabot\nEverything up-to-date'
  assert.equal(extractLink(dependabot, { push: true }), null)
  const hint =
    "remote: Create a pull request for 'feat' on GitHub by visiting:\nremote:      https://github.com/acme/app/pull/new/feat\nremote: https://github.com/acme/app/security/dependabot"
  assert.equal(extractLink(hint, { push: true }), 'https://github.com/acme/app/pull/new/feat')
  assert.equal(extractLink(`${PUSH_OUT}\nremote: https://github.com/acme/app/security/dependabot`, { push: true }), 'https://github.com/acme/app/tree/feat')
})

test('fix 10: quick overrides to the actions file are serialised — none lost', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'triage-actions-file-'))
  const file = new ActionsFile(dir)
  await file.seed()
  await Promise.all(Array.from({ length: 8 }, (_, i) => file.setOverride('not_action', `mcp__s__tool_${i}`, true)))
  const rules = parseActionsFile(readFileSync(file.path, 'utf8')).rules
  for (let i = 0; i < 8; i++) assert.ok(rules.notAction.includes(`mcp__s__tool_${i}`), `tool_${i} kept`)
  assert.deepEqual(file.current().errors, [])
})

test('fix 11: since narrows the list, and calls hydrate across batches', async () => {
  const store = freshStore()
  const t = tracker()
  const ops: ActionOp[] = []
  for (let i = 0; i < 620; i++) ops.push(...t.feed(use(`c${i}`, 'Bash', { command: `gh issue comment ${i} --body x` }), 1000 + i))
  await applyActionOps(store.actions, ops)
  const all = await store.actions.list({ limit: 5000 })
  assert.equal(all.length, 620)
  assert.ok(all.every((a) => a.calls.length === 1 && a.id === `s1:${a.calls[0]}`))
  assert.equal((await store.actions.list({ since: 1600 })).length, 20)
  await store.close()
})

test('fix 12a: Linear save_issue files a ticket — without save becoming a write verb', () => {
  assert.equal(kindOfTool('mcp__linear-server__save_issue'), 'ticket')
  const s = sort('mcp__linear-server__save_issue', { title: 'PX-197' })
  assert.equal(s?.kind, 'ticket')
  assert.equal(s?.why, 'unknown')
})

test('fix 12b: the tracker forgets a prompt once its call settles', () => {
  const t = tracker()
  const promptOf = (t as unknown as { promptOf: Map<string, string> }).promptOf
  for (let i = 0; i < 20; i++) {
    t.feed(use(`t${i}`, 'Bash', { command: 'git push' }), i)
    t.feed(ask(`p${i}`, 'Bash', { command: 'git push' }, `t${i}`), i)
    t.feed(answer(`p${i}`, i % 2 ? 'allow' : 'deny'), i)
    t.feed(result(`t${i}`, 'ok'), i)
  }
  assert.equal(promptOf.size, 0)
})

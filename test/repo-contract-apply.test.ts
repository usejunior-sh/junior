/**
 * The repo contract, applied (plan item `repo-contract-apply`): protected
 * paths hold edits (ask in a chat, refused in a job run), the repo's flaky
 * patterns change ci-sort's answer, its `checks:` make a CI step runnable,
 * its reviewers come before a learned one, and prompts carry its rules.
 * The hold runs on a fake runtime over a real SQLite store, no server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_RULES } from '../core/actions/rules.js'
import { parseContract, EMPTY_CONTRACT, reviewersFor, type RepoContract } from '../core/work/contract.js'
import { protectedEdit, repoNotes, repoRelative } from '../core/work/contract-apply.js'
import { classify } from '../core/babysit/ci-sort.js'
import { localChecks } from '../core/babysit/ci-steps.js'
import { chosenReviewer } from '../core/babysit/reviewer.js'
import { taskPrompt, type TaskPr } from '../core/babysit/brief.js'
import type { ItemTask } from '../core/work/tasks.js'
import type { StoredSession } from '../core/store/types.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

// The server modules fix their data root when they load: keep them off ~/.junior.
const home = mkdtempSync(path.join(os.tmpdir(), 'junior-contract-'))
process.env.JUNIOR_HOME = home
const { holdIfAction } = await import('../server/session/actions-hold.js')
const { readRepoContract } = await import('../server/repo-contract.js')
const { openSqliteStore } = await import('../core/store/sqlite.js')

const file = (yaml: string) => `---\n${yaml}\n---\nNotes for people.\n`
const contractOf = (yaml: string): RepoContract => {
  const { contract, errors } = parseContract(file(yaml))
  assert.deepEqual(errors, [])
  return contract
}

// ── protected paths, pure ───────────────────────────────────────────────────

const ROOT = '/repo'
const c = contractOf('protected: ["db/migrations/", "*.lock"]')

test('protectedEdit: a file tool on a protected path is a hit, elsewhere not', () => {
  assert.deepEqual(protectedEdit(c, ROOT, ROOT, 'Edit', { file_path: '/repo/db/migrations/001.sql' }), { path: 'db/migrations/001.sql', glob: 'db/migrations/' })
  assert.deepEqual(protectedEdit(c, ROOT, ROOT, 'Write', { file_path: 'web/package-lock.lock' }), { path: 'web/package-lock.lock', glob: '*.lock' })
  assert.equal(protectedEdit(c, ROOT, ROOT, 'Edit', { file_path: '/repo/src/db/migrate.ts' }), null)
  assert.equal(protectedEdit(c, ROOT, ROOT, 'Read', { file_path: '/repo/db/migrations/001.sql' }), null)
  // a session folder below the root: relative paths start there
  assert.deepEqual(protectedEdit(c, ROOT, '/repo/db', 'MultiEdit', { file_path: 'migrations/002.sql' })?.glob, 'db/migrations/')
  assert.equal(protectedEdit(c, ROOT, ROOT, 'NotebookEdit', { notebook_path: '/elsewhere/db/migrations/x.ipynb' }), null)
})

test('protectedEdit: the contract file itself is always protected', () => {
  assert.equal(protectedEdit(EMPTY_CONTRACT, ROOT, ROOT, 'Edit', { file_path: '/repo/.junior/junior.md' })?.glob, '.junior/junior.md')
  assert.equal(protectedEdit(EMPTY_CONTRACT, ROOT, ROOT, 'Bash', { command: 'echo "protected: []" > .junior/junior.md' })?.glob, '.junior/junior.md')
  assert.equal(protectedEdit(EMPTY_CONTRACT, ROOT, ROOT, 'Edit', { file_path: '/repo/.junior/notes.md' }), null)
})

test('protectedEdit: shell commands that write into a protected path', () => {
  const bash = (command: string) => protectedEdit(c, ROOT, ROOT, 'Bash', { command })?.path ?? null
  assert.equal(bash('echo x > db/migrations/003.sql'), 'db/migrations/003.sql')
  assert.equal(bash('cat a >> yarn.lock'), 'yarn.lock')
  assert.equal(bash('rm -rf db/migrations'), 'db/migrations')
  assert.equal(bash("sed -i '' s/a/b/ db/migrations/001.sql"), 'db/migrations/001.sql')
  assert.equal(bash('npm test && git checkout -- pnpm.lock'), 'pnpm.lock')
  // reads and unrelated writes pass
  assert.equal(bash('cat db/migrations/001.sql'), null)
  assert.equal(bash('sed -n 1,5p db/migrations/001.sql'), null)
  assert.equal(bash('npm test 2>&1 | tail -5'), null)
  assert.equal(bash('echo x > src/a.ts'), null)
})

test('repoRelative: outside the repo or a ~ path is no path', () => {
  assert.equal(repoRelative('/repo', '/repo', '../other/a.ts'), null)
  assert.equal(repoRelative('/repo', '/repo', '~/x'), null)
  assert.equal(repoRelative('/repo', '/repo/web', './src/a.ts'), 'web/src/a.ts')
})

// ── protected paths, through the hold ───────────────────────────────────────

async function withRepo(fn: (rt: WorkspaceRuntime, repo: string) => Promise<void>) {
  const dir = mkdtempSync(path.join(home, 'ws-'))
  const repo = path.join(dir, 'repo')
  mkdirSync(path.join(repo, '.git'), { recursive: true })
  mkdirSync(path.join(repo, '.junior'), { recursive: true })
  writeFileSync(path.join(repo, '.junior', 'junior.md'), file('protected: ["db/migrations/"]'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  const rt = {
    meta: { id: 'ws-test' },
    store,
    clients: new Set(),
    taskRuns: new Map(),
    sessionTeam: new Map(),
    teamRuns: new Map(),
    sessionItem: new Map(),
    ruleAllowed: new Map(),
    heldCalls: new Map(),
    actionChain: Promise.resolve(),
    actionsDirty: null,
    inboxCache: null,
    connectorCache: null,
    folderProbes: new Map(),
    actionsFile: { current: () => ({ rules: DEFAULT_RULES }) },
  } as unknown as WorkspaceRuntime
  try {
    await fn(rt, repo)
    await rt.actionChain
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

const session = (kind: string, cwd: string) => ({ id: `${kind}-1`, provider: 'claude', kind, cwd, permissionMode: 'auto', jobId: kind === 'job-run' ? 'j1' : null }) as unknown as StoredSession
const NONE = { own: new Set<string>() }

test('hold: an edit to a protected path asks in a chat', async () => {
  await withRepo(async (rt, repo) => {
    const d = await holdIfAction(rt, session('chat', repo), 'Edit', { file_path: path.join(repo, 'db/migrations/001.sql'), old_string: 'a', new_string: 'b' }, NONE)
    assert.equal(d.allow, false)
    assert.equal(!d.allow && d.ask, true)
    assert.match(!d.allow ? d.reason : '', /db\/migrations\/001\.sql is protected by the repo's \.junior\/junior\.md/)
    // elsewhere in the repo, the edit runs
    assert.deepEqual(await holdIfAction(rt, session('chat', repo), 'Edit', { file_path: path.join(repo, 'src/a.ts') }, NONE), { allow: true })
  })
})

test('hold: an edit to a protected path is refused in a job run, not asked', async () => {
  await withRepo(async (rt, repo) => {
    const d = await holdIfAction(rt, session('job-run', repo), 'Write', { file_path: path.join(repo, 'db/migrations/002.sql'), content: 'x' }, NONE)
    assert.equal(d.allow, false)
    assert.equal(!d.allow && d.ask, undefined)
    assert.match(!d.allow ? d.reason : '', /Leave it unchanged/)
    const sh = await holdIfAction(rt, session('job-run', repo), 'Bash', { command: 'rm db/migrations/001.sql' }, NONE)
    assert.equal(sh.allow, false)
  })
})

test('readRepoContract: found from a folder inside the repo, empty without a file', async () => {
  await withRepo(async (_rt, repo) => {
    mkdirSync(path.join(repo, 'web', 'src'), { recursive: true })
    const got = await readRepoContract(path.join(repo, 'web', 'src'))
    assert.equal(got.root, repo)
    assert.equal(got.found, true)
    assert.deepEqual(got.contract.protected, ['db/migrations/'])
    rmSync(path.join(repo, '.junior'), { recursive: true })
    const none = await readRepoContract(repo)
    assert.equal(none.found, false)
    assert.deepEqual(none.contract, EMPTY_CONTRACT)
  })
})

// ── flaky patterns ──────────────────────────────────────────────────────────

const LOG = ['Running e2e suite', 'Error: Snapshot mismatch in checkout.spec', '1 failed'].join('\n')

test('classify: a repo flaky pattern turns a fix into flaky', () => {
  const check = { name: 'e2e (chrome)', conclusion: 'FAILURE' }
  assert.equal(classify(check, null, LOG, []).verdict, 'fix')
  const repo = contractOf('flaky:\n  - { check: "e2e (*)", log: "snapshot mismatch" }')
  const sorted = classify(check, null, LOG, [], repo)
  assert.equal(sorted.verdict, 'flaky')
  assert.equal(sorted.verdict === 'flaky' && sorted.evidence.source, 'repo')
  assert.equal(sorted.verdict === 'flaky' && sorted.evidence.match, 'Error: Snapshot mismatch in checkout.spec')
  assert.match(sorted.why, /^Flaky, per the repo's \.junior\/: /)
  // another check's name: the pattern doesn't apply
  assert.equal(classify({ name: 'unit', conclusion: 'FAILURE' }, null, LOG, [], repo).verdict, 'fix')
  // a matched line naming a file the PR changed is still the PR's own
  assert.equal(classify(check, null, LOG, ['checkout.spec'], repo).verdict, 'fix')
  // main red still comes first
  const main = [{ name: 'e2e (chrome)', status: 'completed', conclusion: 'failure', url: null }]
  assert.equal(classify(check, main, LOG, [], repo).verdict, 'main-red')
})

// ── checks ──────────────────────────────────────────────────────────────────

const WORKFLOW = [
  'name: CI',
  'on: [push]',
  'jobs:',
  '  lint:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - run: npm ci',
  '      - name: Lint',
  '        run: ./scripts/lint.sh --strict',
].join('\n')

test('a `checks:` entry makes a matching CI step runnable', () => {
  const files = [{ path: '.github/workflows/ci.yml', text: WORKFLOW }]
  const scripts = () => ['test', 'lint']
  const before = localChecks(files, 'lint', scripts)
  const lint = (r: typeof before) => r.job?.steps.find((s) => s.label === 'Lint')
  assert.equal(lint(before)?.runnable, false)
  const repo = contractOf('checks: ["./scripts/lint.sh --strict"]')
  const after = localChecks(files, 'lint', scripts, repo.checks)
  assert.equal(lint(after)?.runnable, true)
  assert.equal(lint(after)?.command, './scripts/lint.sh --strict')
  // a different command isn't covered by the entry
  assert.equal(lint(localChecks(files, 'lint', scripts, contractOf('checks: ["./scripts/lint.sh"]').checks))?.runnable, false)
})

// ── reviewers ───────────────────────────────────────────────────────────────

test('reviewers: yours first, then the repo’s for the PR’s paths, never you', () => {
  const repo = contractOf('reviewers:\n  - { path: "web/**", logins: [me, alice] }\n  - { path: "db/", logins: [acme/dba] }')
  const fromRepo = reviewersFor(repo, ['web/src/App.tsx', 'README.md'])
  assert.deepEqual(fromRepo, ['me', 'alice'])
  assert.equal(chosenReviewer(undefined, fromRepo, 'me'), 'alice')
  assert.equal(chosenReviewer({ login: 'bob', at: 0, by: 'you' }, fromRepo, 'me'), 'bob')
  // a learned pick doesn't beat the repo's
  assert.equal(chosenReviewer({ login: 'carol', at: 0, by: 'junior' }, fromRepo, 'me'), 'alice')
  assert.equal(chosenReviewer(undefined, reviewersFor(repo, ['db/schema.sql']), 'me'), 'acme/dba')
  assert.equal(chosenReviewer(undefined, reviewersFor(repo, ['README.md']), 'me'), null)
})

// ── the prompt line ─────────────────────────────────────────────────────────

test('repoNotes: what the contract says, under "From the repo’s .junior/:"', () => {
  assert.deepEqual(repoNotes(EMPTY_CONTRACT), [])
  const notes = repoNotes(contractOf('protected: ["db/migrations/"]\nchecks: ["npm run typecheck"]\nmerge: squash'))
  assert.deepEqual(notes, ["From the repo's .junior/:", "- Protected, don't edit: db/migrations/.", '- Local checks: npm run typecheck.', '- This repo merges by squash.'])
  const pr: TaskPr = { repo: 'acme/api', number: 12, url: 'https://github.com/acme/api/pull/12', headRef: 'feat/x', baseRef: 'main' }
  const task: ItemTask = { id: 't1', itemId: 'github:acme/api#12', title: 'Rebase on main', owner: 'junior', state: 'running', why: 'event', attempts: 1, createdAt: 0, step: 'rebase', input: { why: 'conflict' } }
  const p = taskPrompt(task, pr, undefined, { repoNotes: notes })
  assert.match(p, /From the repo's \.junior\/:\n- Protected, don't edit: db\/migrations\/\./)
  assert.doesNotMatch(taskPrompt(task, pr, undefined), /From the repo's/)
})

test.after(() => rmSync(home, { recursive: true, force: true }))

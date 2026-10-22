/**
 * Worktrees phase 1 (server/worktrees.ts): `git worktree list` parsing, the
 * pure reconcile of checkout rows against it, and discovery end to end
 * against a real repo and sqlite store in a temp dir — never ~/.junior.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'
import type { Store } from '../core/store/types.js'
import type { Checkout, Project } from '../shared/protocol.js'
import { parseWorktreeList } from '../server/git.js'
import { checkRemoval, createWorktree, prepareWorktree, reconcileCheckouts, recreateWorktree, removeWorktree, syncProjectCheckouts } from '../server/worktrees.js'
import { branchFromTitle, plausibleBranch } from '../shared/branch.js'

const project: Project = { id: 'p', name: 'junior', repo: '', path: '/code/junior' }
const row = (over: Partial<Checkout>): Checkout => ({
  id: 'c',
  projectId: 'p',
  kind: 'worktree',
  path: '/wt/a',
  branch: 'fix/a',
  base: null,
  itemId: null,
  state: 'active',
  createdAt: 1,
  ...over,
})
let n = 0
const ids = () => `new-${++n}`

test('worktree list: branches, detached, prunable and bare', () => {
  const out = [
    'worktree /code/junior\nHEAD aaa\nbranch refs/heads/main',
    'worktree /wt/a\nHEAD bbb\nbranch refs/heads/fix/a',
    'worktree /wt/b\nHEAD ccc\ndetached',
    'worktree /wt/gone\nHEAD ddd\nbranch refs/heads/old\nprunable gitdir file points to non-existent location',
    'worktree /bare.git\nbare',
    '',
  ].join('\n\n')
  assert.deepEqual(parseWorktreeList(out), [
    { path: '/code/junior', branch: 'main', primary: true, prunable: false },
    { path: '/wt/a', branch: 'fix/a', primary: false, prunable: false },
    { path: '/wt/b', branch: null, primary: false, prunable: false },
    { path: '/wt/gone', branch: 'old', primary: false, prunable: true },
  ])
})

test('reconcile: a project with no rows gets its main checkout', () => {
  const plan = reconcileCheckouts(project, [], { mainBranch: 'main', worktrees: [] }, 5, ids)
  assert.equal(plan.create.length, 1)
  assert.deepEqual(
    { kind: plan.create[0].kind, path: plan.create[0].path, branch: plan.create[0].branch, state: plan.create[0].state },
    { kind: 'main', path: '/code/junior', branch: 'main', state: 'active' },
  )
})

test('reconcile: main follows the live branch; worktrees appear, move, go and come back', () => {
  const existing = [
    row({ id: 'm', kind: 'main', path: '/code/junior', branch: 'main' }),
    row({ id: 'a', path: '/wt/a', branch: 'fix/a' }),
    row({ id: 'b', path: '/wt/b', branch: 'fix/b' }),
    row({ id: 'c', path: '/wt/c', branch: 'fix/c', state: 'removed' }),
  ]
  const plan = reconcileCheckouts(
    project,
    existing,
    {
      mainBranch: 'feat/due-dates',
      worktrees: [
        { path: '/wt/a', branch: 'fix/a-renamed' },
        { path: '/wt/c', branch: 'fix/c' },
        { path: '/wt/d', branch: 'feat/d' },
      ],
    },
    9,
    ids,
  )
  assert.deepEqual(plan.update, [
    { id: 'm', patch: { branch: 'feat/due-dates' } },
    { id: 'a', patch: { branch: 'fix/a-renamed' } },
    { id: 'b', patch: { state: 'removed' } },
    { id: 'c', patch: { state: 'active' } },
  ])
  assert.deepEqual(plan.create.map((c) => [c.kind, c.path, c.branch]), [['worktree', '/wt/d', 'feat/d']])
})

test('reconcile: when git cannot say, worktree rows are left alone', () => {
  const existing = [row({ id: 'm', kind: 'main', path: '/code/junior', branch: null }), row({ id: 'a' })]
  const plan = reconcileCheckouts(project, existing, { mainBranch: null, worktrees: null }, 9, ids)
  assert.deepEqual(plan, { create: [], update: [] })
})

test('reconcile: another project\'s rows are not this project\'s', () => {
  const plan = reconcileCheckouts(project, [row({ id: 'x', projectId: 'other' })], { mainBranch: 'main', worktrees: [] }, 9, ids)
  assert.deepEqual(plan.update, [])
  assert.equal(plan.create.length, 1)
})

// --- end to end: a real repo, a real worktree, a real store ---------------

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).toString()

async function withRepo(fn: (dir: string, store: Store) => Promise<void>) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'junior-worktrees-')))
  const repo = path.join(dir, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'main', repo])
  git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init')
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  try {
    await fn(dir, store)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('discovery finds a worktree made outside junior, and notices when it goes', () =>
  withRepo(async (dir, store) => {
    const repo = path.join(dir, 'repo')
    const p: Project = { id: 'p', name: 'repo', repo: '', path: repo }
    await store.projects.create(p)

    let got = await syncProjectCheckouts(store.checkouts, [p])
    assert.equal(got.changed, true)
    assert.deepEqual(got.checkouts.map((c) => [c.kind, c.branch, c.state]), [['main', 'main', 'active']])

    const wt = path.join(dir, 'wt-fix')
    git(repo, 'worktree', 'add', '-q', '-b', 'fix/thing', wt)
    got = await syncProjectCheckouts(store.checkouts, [p])
    assert.deepEqual(got.checkouts.map((c) => [c.kind, c.path, c.branch, c.state]), [
      ['main', repo, 'main', 'active'],
      ['worktree', wt, 'fix/thing', 'active'],
    ])

    // Nothing moved: no writes, same rows.
    assert.equal((await syncProjectCheckouts(store.checkouts, [p])).changed, false)

    rmSync(wt, { recursive: true, force: true })
    got = await syncProjectCheckouts(store.checkouts, [p])
    assert.deepEqual(got.checkouts.map((c) => [c.kind, c.state]), [['main', 'active'], ['worktree', 'removed']])
  }))

test('a worktree that is another project of the workspace is left to that project', () =>
  withRepo(async (dir, store) => {
    const repo = path.join(dir, 'repo')
    const wt = path.join(dir, 'wt')
    git(repo, 'worktree', 'add', '-q', '-b', 'side', wt)
    const a: Project = { id: 'a', name: 'repo', repo: '', path: repo }
    const b: Project = { id: 'b', name: 'side', repo: '', path: wt }
    const got = await syncProjectCheckouts(store.checkouts, [a, b])
    const of = (id: string) => got.checkouts.filter((c) => c.projectId === id).map((c) => [c.kind, c.branch])
    assert.deepEqual(of('a'), [['main', 'main']])
    assert.deepEqual(of('b'), [['main', 'side']])
  }))

test('sessions saved before checkouts get their project\'s main one', () =>
  withRepo(async (dir, store) => {
    await store.sessions.create({ id: 's1', title: 'old', cwd: dir, projectId: 'p' })
    await store.sessions.create({ id: 's2', title: 'new', cwd: dir, projectId: 'p', checkoutId: 'wt-1' })
    const n = await store.sessions.backfillCheckouts((projectId) => (projectId === 'p' ? 'main-1' : null))
    assert.equal(n, 1)
    assert.equal((await store.sessions.get('s1'))?.checkoutId, 'main-1')
    assert.equal((await store.sessions.get('s2'))?.checkoutId, 'wt-1')
  }))

// --- phase 2: making, preparing and removing worktrees ---------------------

test('branch names from titles: fix/ for defects, feat/ otherwise, git-safe slugs', () => {
  assert.equal(branchFromTitle('Model list is cached forever, including a failed fetch'), 'fix/model-list-is-cached-forever-including')
  assert.equal(branchFromTitle('Attach any file in the composer'), 'feat/attach-any-file-in-the-composer')
  assert.equal(branchFromTitle('Look at @item:manual:abc please'), 'feat/look-at-please')
  assert.equal(branchFromTitle('   '), '')
  assert.equal(plausibleBranch('fix/a-b'), true)
  assert.equal(plausibleBranch('fix/../x'), false)
  assert.equal(plausibleBranch('has space'), false)
})

test('a new worktree: cut from the default branch, outside the repo, with .env and node_modules', () =>
  withRepo(async (dir, store) => {
    const repo = path.join(dir, 'repo')
    // Like a real repo: what gets copied in is ignored, so it never reads as the worktree's own work.
    writeFileSync(path.join(repo, '.gitignore'), '.env\nnode_modules\n')
    git(repo, 'add', '.gitignore')
    git(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'ignore')
    writeFileSync(path.join(repo, '.env'), 'SECRET=1\n')
    mkdirSync(path.join(repo, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(path.join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    git(repo, 'switch', '-q', '-c', 'elsewhere') // the main folder is on another branch; base is still main
    const p: Project = { id: 'p', name: 'My Repo', repo: '', path: repo }

    const made = await createWorktree(p, 'feat/thing', path.join(dir, 'worktrees'))
    assert.equal(made.base, 'main')
    assert.equal(made.path, path.join(dir, 'worktrees', 'my-repo', 'feat-thing'))
    assert.equal(git(made.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'feat/thing')
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'elsewhere', 'never switches the main folder')

    assert.deepEqual(await prepareWorktree(repo, made.path), [])
    assert.equal(readFileSync(path.join(made.path, '.env'), 'utf8'), 'SECRET=1\n')
    assert.ok(existsSync(path.join(made.path, 'node_modules', 'left-pad', 'index.js')))

    await assert.rejects(createWorktree(p, 'feat/thing', path.join(dir, 'worktrees')), /already has a worktree/)
    await assert.rejects(createWorktree(p, 'bad name', path.join(dir, 'worktrees2')), /valid branch/)

    const got = await syncProjectCheckouts(store.checkouts, [p])
    const wt = got.checkouts.find((c) => c.kind === 'worktree')!
    assert.equal(wt.branch, 'feat/thing')

    // Clean and merged (no commits yet): safe, and removal takes the branch too.
    const check = await checkRemoval(wt, repo, 0)
    assert.deepEqual({ ...check }, { branch: 'feat/thing', base: 'main', unmerged: 0, uncommitted: 0, running: 0, safe: true })
    await removeWorktree(wt, { force: false, deleteBranch: true, merged: true })
    assert.ok(!existsSync(made.path))
    assert.equal(git(repo, 'branch', '--list', 'feat/thing').trim(), '')
  }))

test('unmerged or dirty work makes removal unsafe', () =>
  withRepo(async (dir) => {
    const repo = path.join(dir, 'repo')
    const p: Project = { id: 'p', name: 'repo', repo: '', path: repo }
    const made = await createWorktree(p, 'fix/x', path.join(dir, 'worktrees'))
    git(made.path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'work')
    writeFileSync(path.join(made.path, 'new.txt'), 'hi\n')
    const wt: Checkout = row({ path: made.path, branch: 'fix/x', base: 'main' })
    const check = await checkRemoval(wt, repo, 1)
    assert.deepEqual({ unmerged: check.unmerged, uncommitted: check.uncommitted, running: check.running, safe: check.safe }, {
      unmerged: 1,
      uncommitted: 1,
      running: 1,
      safe: false,
    })
    // Not forced: git itself refuses to drop a dirty worktree.
    await assert.rejects(removeWorktree(wt, { force: false, deleteBranch: true, merged: false }))
    // Forced: folder and branch both go.
    await removeWorktree(wt, { force: true, deleteBranch: true, merged: false })
    assert.ok(!existsSync(made.path))
    assert.equal(git(repo, 'branch', '--list', 'fix/x').trim(), '')
  }))

test('a removed worktree comes back at the same folder — its branch if kept, re-cut if not', () =>
  withRepo(async (dir) => {
    const repo = path.join(dir, 'repo')
    const p: Project = { id: 'p', name: 'repo', repo: '', path: repo }
    const made = await createWorktree(p, 'fix/back', path.join(dir, 'worktrees'))
    git(made.path, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'kept work')
    const wt: Checkout = row({ path: made.path, branch: 'fix/back', base: 'main', state: 'removed' })

    // Folder gone, branch kept: the same commits come back.
    await removeWorktree(wt, { force: true, deleteBranch: false, merged: false })
    await recreateWorktree(wt, p)
    assert.equal(git(made.path, 'log', '-1', '--format=%s').trim(), 'kept work')

    // Folder deleted by hand and branch gone: pruned, then re-cut from main under the same name.
    rmSync(made.path, { recursive: true, force: true })
    git(repo, 'worktree', 'prune')
    git(repo, 'branch', '-D', 'fix/back')
    await recreateWorktree(wt, p)
    assert.equal(git(made.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'fix/back')
    assert.equal(git(made.path, 'log', '-1', '--format=%s').trim(), 'init')

    await assert.rejects(recreateWorktree(wt, p), /already there/)
  }))

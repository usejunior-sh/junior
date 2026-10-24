/**
 * Project suggestions (plan item project-suggestions-core): the pure ranker
 * in core/junior/project-rank.ts with a fake clock, and the scan in
 * server/project-suggestions.ts against a fixture Claude folder in a temp
 * dir. Nothing here reads the real home folder or ~/.claude.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  decodeProjectKey,
  originUrlFromGitConfig,
  projectKey,
  rankProjects,
  repoFromRemoteUrl,
  type ProjectSighting,
} from '../core/junior/project-rank.js'
import { repoOf, scanClaudeProjects, suggestProjects } from '../server/project-suggestions.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 24, 12)
const daysAgo = (n: number) => NOW - n * DAY
const sight = (repoRoot: string, ages: number[], extra: Partial<ProjectSighting> = {}): ProjectSighting => ({
  path: repoRoot,
  repoRoot,
  sessions: ages.map(daysAgo),
  ...extra,
})

// ---- the pure ranker -------------------------------------------------------

test('rank: more recent sessions beat many old ones', () => {
  const out = rankProjects([sight('/c/old', Array(20).fill(120)), sight('/c/new', [0, 1, 2])], { now: NOW })
  assert.deepEqual(out.map((s) => s.path), ['/c/new', '/c/old'])
})

test('rank: more sessions win at the same age', () => {
  const out = rankProjects([sight('/c/a', [3]), sight('/c/b', [3, 3, 3])], { now: NOW })
  assert.deepEqual(out.map((s) => s.path), ['/c/b', '/c/a'])
})

test('rank: sightings of one repo merge (subfolders and worktrees count toward it)', () => {
  const out = rankProjects(
    [
      sight('/c/app', [1]),
      { path: '/c/app/web', repoRoot: '/c/app', sessions: [daysAgo(2)] },
      { path: '/c/app-wt', repoRoot: '/c/app/', sessions: [daysAgo(0)], repo: 'acme/app' },
    ],
    { now: NOW },
  )
  assert.equal(out.length, 1)
  assert.equal(out[0]!.path, '/c/app')
  assert.equal(out[0]!.sessions, 3)
  assert.equal(out[0]!.repo, 'acme/app')
  assert.equal(out[0]!.lastActiveAt, daysAgo(0))
  assert.equal(out[0]!.name, 'app')
})

test('rank: existing projects, the home folder and root are never suggested', () => {
  const out = rankProjects([sight('/c/a', [1]), sight('/c/b/', [1]), sight('/Users/me', [0]), sight('/', [0])], {
    now: NOW,
    existing: ['/c/b'],
    home: '/Users/me/',
  })
  assert.deepEqual(out.map((s) => s.path), ['/c/a'])
})

test('rank: sessions past maxAgeDays drop out, and a repo with none left is dropped', () => {
  const out = rankProjects([sight('/c/stale', [200, 400]), sight('/c/mixed', [1, 300])], { now: NOW })
  assert.deepEqual(out.map((s) => [s.path, s.sessions]), [['/c/mixed', 1]])
})

test('rank: ties break newest first, then by path; limit caps the list', () => {
  const out = rankProjects([sight('/c/b', [5]), sight('/c/a', [5]), sight('/c/z', [5])], { now: NOW, limit: 2 })
  assert.deepEqual(out.map((s) => s.path), ['/c/a', '/c/b'])
  assert.deepEqual(rankProjects([sight('/c/a', [1])], { now: NOW, limit: 0 }), [])
})

test('rank: the why line counts sessions and says how long ago', () => {
  const [one] = rankProjects([sight('/c/a', [0])], { now: NOW })
  assert.equal(one!.why, '1 Claude Code session, last today')
  const [many] = rankProjects([sight('/c/a', [3, 9, 20])], { now: NOW })
  assert.equal(many!.why, '3 Claude Code sessions, last 3 days ago')
  const [y] = rankProjects([sight('/c/a', [1])], { now: NOW })
  assert.match(y!.why, /last yesterday$/)
})

test('rank: a session halves in weight every halfLifeDays', () => {
  const [s] = rankProjects([sight('/c/a', [0, 14])], { now: NOW, halfLifeDays: 14 })
  assert.equal(s!.score, 1.5)
})

test('rank: is pure (same input, same output; input untouched)', () => {
  const input = [sight('/c/a', [1, 2]), sight('/c/b', [3])]
  const copy = structuredClone(input)
  assert.deepEqual(rankProjects(input, { now: NOW }), rankProjects(input, { now: NOW }))
  assert.deepEqual(input, copy)
})

// ---- small pure helpers ----------------------------------------------------

test('projectKey: every non-alphanumeric becomes a dash, like Claude Code', () => {
  assert.equal(projectKey('/Users/me/Code/my-app/.claude/wt_1'), '-Users-me-Code-my-app--claude-wt-1')
})

test('decodeProjectKey: walks the dashes against the disk, hyphens and dots included', () => {
  const dirs = new Set(['/Users', '/Users/me', '/Users/me/Code', '/Users/me/Code/my-app', '/Users/me/Code/my-app/.claude', '/Users/me/Code/my-app/.claude/wt_1'])
  const isDir = (p: string) => dirs.has(p)
  assert.equal(decodeProjectKey(projectKey('/Users/me/Code/my-app'), isDir), '/Users/me/Code/my-app')
  assert.equal(decodeProjectKey(projectKey('/Users/me/Code/my-app/.claude/wt_1'), isDir), '/Users/me/Code/my-app/.claude/wt_1')
  assert.equal(decodeProjectKey(projectKey('/Users/me/Code/gone'), isDir), null)
  assert.equal(decodeProjectKey('no-leading-dash', isDir), null)
})

test('decodeProjectKey: a probe budget stops a key full of dashes', () => {
  let probes = 0
  const out = decodeProjectKey('-' + 'a-'.repeat(40) + 'a', () => (probes++, true), () => false, 200)
  assert.equal(out, null)
  assert.ok(probes < 1000, `probes ${probes}`)
})

test('repoFromRemoteUrl and originUrlFromGitConfig', () => {
  assert.equal(repoFromRemoteUrl('git@github.com:acme/app.git'), 'acme/app')
  assert.equal(repoFromRemoteUrl('https://github.com/acme/my.app'), 'acme/my.app')
  assert.equal(repoFromRemoteUrl('https://gitlab.com/acme/app.git'), null)
  const cfg = '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:other/x.git\n[remote "origin"]\n\turl = git@github.com:acme/app.git\n'
  assert.equal(originUrlFromGitConfig(cfg), 'git@github.com:acme/app.git')
  assert.equal(originUrlFromGitConfig('[core]\n'), null)
})

// ---- the scan, over a fixture folder ----------------------------------------

function fixture() {
  // realpath: macOS tmpdir is a symlink (/var → /private/var); Claude records the real cwd
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'junior-psugg-')))
  const projects = path.join(root, 'claude', 'projects')
  const code = path.join(root, 'code')
  const repo = (dir: string, origin?: string) => {
    mkdirSync(path.join(dir, '.git'), { recursive: true })
    writeFileSync(path.join(dir, '.git', 'config'), origin ? `[remote "origin"]\n\turl = ${origin}\n` : '[core]\n')
  }
  const app = path.join(code, 'my-app')
  repo(app, 'git@github.com:acme/my-app.git')
  mkdirSync(path.join(app, 'web'), { recursive: true })
  // a worktree of my-app, elsewhere on disk
  const wt = path.join(root, 'worktrees', 'feat')
  mkdirSync(path.join(app, '.git', 'worktrees', 'feat'), { recursive: true })
  mkdirSync(wt, { recursive: true })
  writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(app, '.git', 'worktrees', 'feat')}\n`)
  const lib = path.join(code, 'lib')
  repo(lib)
  const notes = path.join(code, 'notes') // not a repo
  mkdirSync(notes, { recursive: true })

  /** a Claude project folder for `cwd` with sessions written `ages` days ago */
  const sessions = (cwd: string, ages: number[], opts: { cwdInFile?: boolean } = {}) => {
    const dir = path.join(projects, projectKey(cwd))
    mkdirSync(dir, { recursive: true })
    ages.forEach((age, i) => {
      const f = path.join(dir, `s${i}.jsonl`)
      const lines = [JSON.stringify({ type: 'summary', summary: 'x' })]
      if (opts.cwdInFile !== false) lines.push(JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } }))
      writeFileSync(f, lines.join('\n') + '\n')
      const t = new Date(daysAgo(age))
      utimesSync(f, t, t)
    })
  }
  sessions(app, [0, 1, 2])
  sessions(path.join(app, 'web'), [1])
  sessions(wt, [0])
  sessions(lib, [10], { cwdInFile: false }) // only the folder name to go on
  sessions(notes, [0, 0, 0, 0])
  sessions(path.join(code, 'deleted'), [0, 0])
  mkdirSync(path.join(projects, projectKey(path.join(code, 'empty'))), { recursive: true }) // no session files
  return { root, projects, app, wt, lib, notes, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('repoOf: walks up to the repo, and a worktree resolves to its main repo', () => {
  const f = fixture()
  try {
    assert.deepEqual(repoOf(path.join(f.app, 'web')), { root: f.app, repo: 'acme/my-app' })
    assert.deepEqual(repoOf(f.wt), { root: f.app, repo: 'acme/my-app' })
    assert.deepEqual(repoOf(f.lib), { root: f.lib, repo: undefined })
    assert.equal(repoOf(f.notes), null)
  } finally {
    f.cleanup()
  }
})

test('scan: keeps folders that exist and sit in a git repo; drops the rest', async () => {
  const f = fixture()
  try {
    const found = await scanClaudeProjects(f.projects)
    const paths = found.map((s) => s.path).sort()
    assert.deepEqual(paths, [f.lib, f.app, path.join(f.app, 'web'), f.wt].sort())
    const lib = found.find((s) => s.path === f.lib)!
    assert.equal(lib.repoRoot, f.lib, 'decoded from the folder name when no session names a cwd')
    assert.equal(found.find((s) => s.path === f.app)!.sessions.length, 3)
  } finally {
    f.cleanup()
  }
})

test('scan: a missing Claude folder is no suggestions, not an error', async () => {
  assert.deepEqual(await scanClaudeProjects(path.join(tmpdir(), 'junior-psugg-does-not-exist', 'projects')), [])
})

test('suggestProjects: ranks the fixture, merges worktrees, skips existing projects', async () => {
  const f = fixture()
  try {
    const out = await suggestProjects(f.projects, { now: NOW })
    assert.deepEqual(out.map((s) => [s.path, s.sessions, s.repo]), [
      [f.app, 5, 'acme/my-app'],
      [f.lib, 1, ''],
    ])
    assert.equal(out[0]!.name, 'my-app')
    const without = await suggestProjects(f.projects, { now: NOW, existing: [f.app + '/'] })
    assert.deepEqual(without.map((s) => s.path), [f.lib])
  } finally {
    f.cleanup()
  }
})

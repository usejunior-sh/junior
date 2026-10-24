/**
 * `/remember` (shared/remember.ts + rememberOp in server/settings-ops.ts):
 * spotting the verb, checking the line, appending one bullet to the right
 * context file without touching the rest, and never adding a line twice.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendBullet, hasLine, pathHint, rememberArg, rememberLine, savedCopy, REMEMBER_MAX } from '../shared/remember.js'
import type { WorkspaceRuntime } from '../server/workspace/runtime.js'

// The op resolves the workspace folder through the registry; keep it off the real ~/.junior.
const home = mkdtempSync(path.join(tmpdir(), 'junior-remember-home-'))
process.env.JUNIOR_HOME = home
const { rememberOp, contextTargetOp } = await import('../server/settings-ops.js')
const { workspaceDir } = await import('../server/workspaces.js')
test.after(() => rmSync(home, { recursive: true, force: true }))

test('rememberArg spots only the verb at the start', () => {
  assert.equal(rememberArg('/remember we squash-merge in novus'), 'we squash-merge in novus')
  assert.equal(rememberArg('/remember'), '')
  assert.equal(rememberArg('/remember '), '')
  assert.equal(rememberArg('/remember\nline two'), 'line two')
  assert.equal(rememberArg('/rememberize this'), null)
  assert.equal(rememberArg('please /remember this'), null)
  assert.equal(rememberArg('/review'), null)
})

test('rememberLine folds newlines, strips invisible characters, and caps the length', () => {
  assert.deepEqual(rememberLine('  we  squash\nmerge ​ '), { ok: true, line: 'we squash merge' })
  assert.equal(rememberLine('').ok, false)
  assert.equal(rememberLine('​​').ok, false)
  assert.equal(rememberLine(42).ok, false)
  assert.equal(rememberLine('x'.repeat(REMEMBER_MAX)).ok, true)
  const long = rememberLine('x'.repeat(REMEMBER_MAX + 1))
  assert.equal(long.ok, false)
  if (!long.ok) assert.equal(long.error, 'Keep it to one line, under 500 characters.')
})

test('hasLine ignores case, spaces and the bullet', () => {
  const file = '# Novus\n- We squash-merge in novus\nplain line\n'
  assert.equal(hasLine(file, 'we  squash-merge in NOVUS'), true)
  assert.equal(hasLine(file, 'Plain line'), true)
  assert.equal(hasLine(file, 'we rebase'), false)
})

test('appendBullet adds one line and keeps the rest', () => {
  assert.equal(appendBullet('', 'a'), '- a\n')
  assert.equal(appendBullet('# Head\n', 'a'), '# Head\n- a\n')
  assert.equal(appendBullet('# Head', 'a'), '# Head\n- a\n')
})

test('copy names the file', () => {
  assert.equal(savedCopy('project', 'novus'), 'Saved to novus/.junior/context.md.')
  assert.equal(savedCopy('workspace'), 'Saved to the workspace context.md.')
  assert.match(pathHint('project'), /^\.junior\/context\.md/)
  assert.match(pathHint('workspace'), /^Workspace context\.md/)
})

function fakeRt(projects: { id: string; name: string; path: string }[]): WorkspaceRuntime {
  return { meta: { id: 'ws-remember' }, store: { projects: { list: async () => projects } } } as unknown as WorkspaceRuntime
}

test('rememberOp appends to the project file, made when missing, and never twice', async () => {
  const proj = mkdtempSync(path.join(tmpdir(), 'junior-remember-proj-'))
  try {
    const rt = fakeRt([{ id: 'p1', name: 'novus', path: proj }])
    const file = path.join(proj, '.junior', 'context.md')
    const first = await rememberOp(rt, { scope: 'project', projectId: 'p1', text: 'we squash-merge in novus' })
    assert.deepEqual(first, { path: file, already: false, line: 'we squash-merge in novus' })
    assert.equal(readFileSync(file, 'utf8'), '- we squash-merge in novus\n')
    const again = await rememberOp(rt, { scope: 'project', projectId: 'p1', text: 'We  squash-merge in novus' })
    assert.equal(again.already, true)
    // Two at once still land as two lines.
    await Promise.all([
      rememberOp(rt, { scope: 'project', projectId: 'p1', text: 'one' }),
      rememberOp(rt, { scope: 'project', projectId: 'p1', text: 'two' }),
    ])
    assert.equal(readFileSync(file, 'utf8'), '- we squash-merge in novus\n- one\n- two\n')
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})

test('rememberOp keeps a file that has no newline at the end', async () => {
  const proj = mkdtempSync(path.join(tmpdir(), 'junior-remember-proj-'))
  try {
    mkdirSync(path.join(proj, '.junior'))
    const file = path.join(proj, '.junior', 'context.md')
    writeFileSync(file, '# Notes\nKeep PRs small')
    await rememberOp(fakeRt([{ id: 'p1', name: 'novus', path: proj }]), { scope: 'project', projectId: 'p1', text: 'tests first' })
    assert.equal(readFileSync(file, 'utf8'), '# Notes\nKeep PRs small\n- tests first\n')
  } finally {
    rmSync(proj, { recursive: true, force: true })
  }
})

test('rememberOp writes the workspace file for the workspace scope', async () => {
  const rt = fakeRt([])
  const out = await rememberOp(rt, { scope: 'workspace', text: 'answer in short lines' })
  assert.equal(out.path, path.join(workspaceDir('ws-remember'), 'context.md'))
  assert.equal(readFileSync(out.path, 'utf8'), '- answer in short lines\n')
})

test('rememberOp refuses bad input and writes nothing', async () => {
  const rt = fakeRt([{ id: 'p1', name: 'novus', path: path.join(home, 'gone') }])
  await assert.rejects(rememberOp(rt, { scope: 'project', projectId: 'p1', text: '' }), /Type what Junior should remember/)
  await assert.rejects(rememberOp(rt, { scope: 'project', text: 'x' }), /no project/)
  await assert.rejects(rememberOp(rt, { scope: 'project', projectId: 'nope', text: 'x' }), /project is gone/)
  await assert.rejects(rememberOp(rt, { scope: 'project', projectId: 'p1', text: 'x' }), /folder is gone/)
  await assert.rejects(rememberOp(rt, { scope: 'team', text: 'x' }), /scope must be/)
  await assert.rejects(contextTargetOp(rt, null), /scope must be/)
})

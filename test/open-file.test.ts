/**
 * Opening a file a session wrote (POST /api/sessions/:id/open-file): only a
 * file under one of the session's project folders gets to an editor — not a
 * `..` escape, a symlink pointing out, a look-alike sibling folder or a folder.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openableFile } from '../server/editors.js'

async function fixture() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'triage-open-file-')))
  const project = path.join(base, 'proj')
  const worktree = path.join(base, 'worktrees', 'feat-x')
  const sibling = path.join(base, 'proj-evil')
  for (const d of [path.join(project, 'src'), worktree, sibling]) await fs.mkdir(d, { recursive: true })
  await fs.writeFile(path.join(project, 'src', 'a.ts'), 'a')
  await fs.writeFile(path.join(worktree, 'b.ts'), 'b')
  await fs.writeFile(path.join(sibling, 'secret.txt'), 's')
  await fs.writeFile(path.join(base, 'outside.txt'), 'o')
  await fs.symlink(path.join(base, 'outside.txt'), path.join(project, 'link.txt'))
  return { base, project, worktree, sibling, roots: [project, worktree] }
}

test('open-file: a file inside the project opens, by absolute or cwd-relative path', async () => {
  const f = await fixture()
  const abs = path.join(f.project, 'src', 'a.ts')
  assert.equal(await openableFile(abs, f.project, f.roots), abs)
  assert.equal(await openableFile('src/a.ts', f.project, f.roots), abs)
})

test('open-file: a file in another checkout of the same project opens', async () => {
  const f = await fixture()
  assert.equal(await openableFile(path.join(f.worktree, 'b.ts'), f.project, f.roots), path.join(f.worktree, 'b.ts'))
})

test('open-file: paths outside the project are refused', async () => {
  const f = await fixture()
  await assert.rejects(openableFile(path.join(f.base, 'outside.txt'), f.project, f.roots), /outside this session's project/)
  await assert.rejects(openableFile('../outside.txt', f.project, f.roots), /outside this session's project/)
  await assert.rejects(openableFile('/etc/hosts', f.project, f.roots), /outside this session's project/)
  // A folder whose name merely starts with the project's is not inside it.
  await assert.rejects(openableFile(path.join(f.sibling, 'secret.txt'), f.project, f.roots), /outside this session's project/)
  // A symlink inside the project pointing out of it is judged by where it points.
  await assert.rejects(openableFile(path.join(f.project, 'link.txt'), f.project, f.roots), /outside this session's project/)
})

test('open-file: a missing path, a folder and an empty path are refused', async () => {
  const f = await fixture()
  await assert.rejects(openableFile(path.join(f.project, 'nope.ts'), f.project, f.roots), /is gone/)
  await assert.rejects(openableFile(path.join(f.project, 'src'), f.project, f.roots), /a folder, not a file/)
  await assert.rejects(openableFile('', f.project, f.roots), /need a file/)
})

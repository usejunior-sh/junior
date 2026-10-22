/**
 * Skills and agents (server/library.ts, shared/skillFile.ts): the lenient
 * frontmatter reader, the surgical field writer, and the file API's fences —
 * listing every root, refusing paths outside them, plugins read-only, deletes
 * to the trash. Real files in a temp dir; no server.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { bodyOf, readFields, setBody, setField } from '../shared/skillFile.js'
import {
  createLibraryEntry,
  ensureWorkspacePlugin,
  libraryRoots,
  listLibrary,
  locate,
  readLibraryFile,
  removeLibraryItem,
  writeLibraryFile,
} from '../server/library.js'

const SKILL = `---
name: book
description: >
  Write a learning book
  about a topic.
allowed-tools:
  - Read
  - Write
metadata:
  owner: me
---

# Book

Body here.
`

test('readFields folds block scalars, joins lists, skips nested maps', () => {
  const f = readFields(SKILL)
  assert.equal(f.name, 'book')
  assert.equal(f.description, 'Write a learning book about a topic.')
  assert.equal(f['allowed-tools'], 'Read, Write')
  assert.equal(f.metadata, '')
  assert.equal(readFields('---\ntools: [Read, "Grep"]\ncolor: \'blue\'\n---\nx').tools, 'Read, Grep')
  assert.deepEqual(readFields('no frontmatter'), {})
})

test('setField rewrites one key and leaves the rest as written', () => {
  const out = setField(SKILL, 'description', 'Teach: one topic')
  assert.match(out, /^description: "Teach: one topic"$/m)
  assert.ok(out.includes('allowed-tools:\n  - Read\n  - Write\nmetadata:\n  owner: me'))
  assert.equal(readFields(out).description, 'Teach: one topic')
  assert.equal(bodyOf(out), bodyOf(SKILL))
  // add, multi-line, remove
  const added = setField(out, 'model', 'sonnet')
  assert.equal(readFields(added).model, 'sonnet')
  const multi = setField(added, 'description', 'line one\nline two')
  assert.equal(readFields(multi).description, 'line one\nline two')
  assert.equal(readFields(setField(multi, 'model', null)).model, undefined)
  // a file with no frontmatter gains one
  assert.equal(readFields(setField('just a prompt', 'name', 'x')).name, 'x')
  assert.equal(bodyOf(setField('just a prompt', 'name', 'x')), 'just a prompt')
})

test('setBody keeps the frontmatter byte for byte', () => {
  const out = setBody(SKILL, 'New body\n')
  assert.ok(out.startsWith(SKILL.slice(0, SKILL.indexOf('\n---\n') + 5)))
  assert.equal(bodyOf(out), 'New body\n')
  // the blank line after the fence survives both writers
  assert.ok(setBody(SKILL, 'x').includes('---\n\nx'))
  assert.ok(setField(SKILL, 'name', 'b').includes('---\n\n# Book'))
  assert.ok(setBody('---\nname: a\n---\nbody', 'x').endsWith('---\nx'))
})

async function fixture() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'junior-library-'))
  const home = path.join(tmp, 'claude')
  const project = path.join(tmp, 'repo')
  const lib = path.join(tmp, 'ws', 'library')
  const pluginDir = path.join(tmp, 'plugin-cache', 'tools')
  await ensureWorkspacePlugin(lib)
  await mkdir(path.join(home, 'skills', 'book', 'scripts'), { recursive: true })
  await writeFile(path.join(home, 'skills', 'book', 'SKILL.md'), SKILL)
  await writeFile(path.join(home, 'skills', 'book', 'scripts', 'build.py'), 'print(1)\n')
  await mkdir(path.join(project, '.claude', 'agents'), { recursive: true })
  await writeFile(path.join(project, '.claude', 'agents', 'scout.md'), '---\nname: scout\ndescription: Looks around\nmodel: haiku\n---\nYou scout.\n')
  await mkdir(path.join(pluginDir, 'skills', 'lint'), { recursive: true })
  await writeFile(path.join(pluginDir, 'skills', 'lint', 'SKILL.md'), '---\nname: lint\ndescription: Lints\n---\nlint\n')
  await mkdir(path.join(home, 'plugins'), { recursive: true })
  await writeFile(
    path.join(home, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'tools@market': [{ scope: 'user', installPath: pluginDir }], 'off@market': [{ scope: 'user', installPath: path.join(tmp, 'off') }] } }),
  )
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ enabledPlugins: { 'tools@market': true, 'off@market': false } }))
  const roots = await libraryRoots({ workspaceLibrary: lib, env: { CLAUDE_CONFIG_DIR: home }, projects: [{ name: 'repo', path: project }] })
  return { tmp, home, project, lib, pluginDir, roots }
}

test('every root is listed, with namespaced names for the workspace and plugins', async () => {
  const { roots, lib } = await fixture()
  assert.deepEqual(
    roots.map((r) => [r.source, r.editable]),
    [
      ['workspace', true],
      ['personal', true],
      ['project', true],
      ['plugin', false],
    ],
  )
  assert.ok(existsSync(path.join(lib, '.claude-plugin', 'plugin.json')))
  const skills = await listLibrary('skill', roots)
  assert.deepEqual(
    skills.map((s) => [s.name, s.source, s.editable, s.files]),
    [
      ['book', 'personal', true, 1],
      ['tools:lint', 'plugin', false, 0],
    ],
  )
  assert.equal(skills[0].description, 'Write a learning book about a topic.')
  const agents = await listLibrary('agent', roots)
  assert.deepEqual(agents.map((a) => [a.name, a.scope, a.model]), [['scout', 'repo', 'haiku']])
})

test('create makes a template in the target root and refuses a taken name', async () => {
  const { roots, lib } = await fixture()
  const made = await createLibraryEntry({ kind: 'skill', target: 'workspace', name: 'Release Notes', description: 'Drafts notes' }, roots)
  assert.equal(made.path, path.join(lib, 'skills', 'release-notes', 'SKILL.md'))
  assert.equal(readFields(await readFile(made.path, 'utf8')).description, 'Drafts notes')
  await assert.rejects(createLibraryEntry({ kind: 'skill', target: 'workspace', name: 'release notes' }, roots), /already has/)
  const agent = await createLibraryEntry({ kind: 'agent', target: 'personal', name: 'critic' }, roots)
  assert.ok(agent.path.endsWith(path.join('agents', 'critic.md')))
  assert.equal((await listLibrary('skill', roots)).find((s) => s.slug === 'release-notes')?.name, 'junior:release-notes')
  await assert.rejects(createLibraryEntry({ kind: 'skill', target: 'nowhere', name: 'x' }, roots), /pick where/)
})

test('reads and writes stay inside skill and agent folders; plugins are read-only', async () => {
  const { roots, home, pluginDir, tmp } = await fixture()
  const skill = path.join(home, 'skills', 'book', 'SKILL.md')
  const read = await readLibraryFile(skill, roots)
  assert.deepEqual(read.files, ['SKILL.md', 'scripts/build.py'])
  assert.equal(read.editable, true)
  await writeLibraryFile(path.join(home, 'skills', 'book', 'scripts', 'build.py'), 'print(2)\n', roots)
  assert.equal(await readFile(path.join(home, 'skills', 'book', 'scripts', 'build.py'), 'utf8'), 'print(2)\n')

  assert.throws(() => locate(path.join(home, 'settings.json'), roots), /not a skill or agent/)
  assert.throws(() => locate(path.join(home, 'skills', 'book'), roots), /not a skill or agent/)
  assert.throws(() => locate('relative/SKILL.md', roots), /absolute/)
  assert.throws(() => locate(path.join(home, 'skills', 'book', '..', '..', 'settings.json'), roots), /not a skill or agent/)
  await assert.rejects(writeLibraryFile(path.join(pluginDir, 'skills', 'lint', 'SKILL.md'), 'x', roots), /read-only/)
  assert.equal((await readLibraryFile(path.join(pluginDir, 'skills', 'lint', 'SKILL.md'), roots)).editable, false)

  // a symlink planted inside a skill that points out of it
  await writeFile(path.join(tmp, 'secret.txt'), 'nope')
  await symlink(path.join(tmp, 'secret.txt'), path.join(home, 'skills', 'book', 'leak.txt'))
  await assert.rejects(readLibraryFile(path.join(home, 'skills', 'book', 'leak.txt'), roots), /leaves its folder/)
})

test('delete moves to the trash: a whole skill, one file, or an agent', async () => {
  const { roots, home, project, tmp } = await fixture()
  const trash = path.join(tmp, 'trash')
  await assert.rejects(removeLibraryItem(path.join(home, 'skills', 'book', 'SKILL.md'), roots, trash, { fileOnly: true }), /delete the skill/)
  await removeLibraryItem(path.join(home, 'skills', 'book', 'scripts', 'build.py'), roots, trash, { fileOnly: true })
  assert.ok(existsSync(path.join(home, 'skills', 'book', 'SKILL.md')))
  await removeLibraryItem(path.join(home, 'skills', 'book', 'SKILL.md'), roots, trash)
  assert.ok(!existsSync(path.join(home, 'skills', 'book')))
  await removeLibraryItem(path.join(project, '.claude', 'agents', 'scout.md'), roots, trash)
  assert.equal((await readdir(trash)).length, 3)
})

test('a linked skill folder is listed and editable, and deleting it drops only the link', async () => {
  const { roots, home, tmp } = await fixture()
  const real = path.join(tmp, 'my-skills', 'linked')
  await mkdir(real, { recursive: true })
  await writeFile(path.join(real, 'SKILL.md'), '---\nname: linked\ndescription: d\n---\nx\n')
  await symlink(real, path.join(home, 'skills', 'linked'))
  assert.ok((await listLibrary('skill', roots)).some((s) => s.slug === 'linked'))
  await writeLibraryFile(path.join(home, 'skills', 'linked', 'SKILL.md'), 'changed', roots)
  assert.equal(await readFile(path.join(real, 'SKILL.md'), 'utf8'), 'changed')
  await removeLibraryItem(path.join(home, 'skills', 'linked', 'SKILL.md'), roots, path.join(tmp, 'trash'))
  assert.ok(existsSync(path.join(real, 'SKILL.md')))
  assert.ok(!existsSync(path.join(home, 'skills', 'linked')))
})

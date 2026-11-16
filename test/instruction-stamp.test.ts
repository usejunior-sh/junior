/**
 * The instruction stamp (server/session/instruction-stamp.ts): which CLAUDE.md
 * files a chat read at spawn, and whether one changed since, so its next
 * message resumes in a process that reads the edit.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { changedFiles, claudeMdPlaces, stampOf } from '../server/session/instruction-stamp.js'
import { noteBackgroundTask } from '../core/workflows/tasks.js'
import type { SdkMessage } from '../shared/protocol.js'

const root = mkdtempSync(path.join(tmpdir(), 'junior-stamp-'))
test.after(() => rmSync(root, { recursive: true, force: true }))

const config = path.join(root, 'claude')
const repo = path.join(root, 'code', 'repo')
const cwd = path.join(repo, 'pkg')
mkdirSync(cwd, { recursive: true })
mkdirSync(config, { recursive: true })

const stampNow = () => {
  const { files, ruleDirs } = claudeMdPlaces(cwd, config)
  return stampOf(files, ruleDirs)
}

test('every folder from the session up to / is a place, with the user config and its rules', () => {
  const { files, ruleDirs } = claudeMdPlaces(cwd, config)
  assert.ok(files.includes(path.join(config, 'CLAUDE.md')))
  for (const dir of [cwd, repo, path.join(root, 'code'), '/']) {
    assert.ok(files.includes(path.join(dir, 'CLAUDE.md')), dir)
    assert.ok(files.includes(path.join(dir, '.claude', 'CLAUDE.md')), dir)
    assert.ok(files.includes(path.join(dir, 'CLAUDE.local.md')), dir)
    assert.ok(ruleDirs.includes(path.join(dir, '.claude', 'rules')), dir)
  }
  assert.ok(ruleDirs.includes(path.join(config, 'rules')))
})

test('an edit, a new file, a new rule and a deleted file each show as changed; a resave does not', async () => {
  writeFileSync(path.join(repo, 'CLAUDE.md'), '# repo\n')
  writeFileSync(path.join(config, 'CLAUDE.md'), '# me\n')
  const first = await stampNow()
  assert.deepEqual(changedFiles(first, await stampNow()), [])

  // Saved again with the same words: nothing to reload.
  writeFileSync(path.join(repo, 'CLAUDE.md'), '# repo\n')
  assert.deepEqual(changedFiles(first, await stampNow()), [])

  writeFileSync(path.join(repo, 'CLAUDE.md'), '# repo\nnew rule\n')
  const edited = await stampNow()
  assert.deepEqual(changedFiles(first, edited), [path.join(repo, 'CLAUDE.md')])

  writeFileSync(path.join(cwd, 'CLAUDE.local.md'), 'mine\n')
  const added = await stampNow()
  assert.deepEqual(changedFiles(edited, added), [path.join(cwd, 'CLAUDE.local.md')])

  const rules = path.join(repo, '.claude', 'rules', 'nested')
  mkdirSync(rules, { recursive: true })
  writeFileSync(path.join(rules, 'style.md'), 'short sentences\n')
  writeFileSync(path.join(rules, 'notes.txt'), 'not a rule\n')
  const ruled = await stampNow()
  assert.deepEqual(changedFiles(added, ruled), [path.join(rules, 'style.md')])

  rmSync(path.join(config, 'CLAUDE.md'))
  assert.deepEqual(changedFiles(ruled, await stampNow()), [path.join(config, 'CLAUDE.md')])
})

const sys = (m: Record<string, unknown>) => ({ type: 'system', ...m }) as SdkMessage

test('background tasks of any kind are tracked until they end, and the level signal replaces the set', () => {
  const running = new Set<string>()
  assert.equal(noteBackgroundTask(running, sys({ subtype: 'task_started', task_id: 'a', task_type: 'local_agent' })), true)
  assert.equal(noteBackgroundTask(running, sys({ subtype: 'task_started', task_id: 'b', task_type: 'local_bash' })), true)
  assert.deepEqual([...running], ['a', 'b'])
  noteBackgroundTask(running, sys({ subtype: 'task_notification', task_id: 'a', status: 'completed' }))
  assert.deepEqual([...running], ['b'])
  noteBackgroundTask(running, sys({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'c', task_type: 'local_bash' }, { task_id: 'd', task_type: 'x', ambient: true }] }))
  assert.deepEqual([...running], ['c'])
})

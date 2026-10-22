/**
 * The Triage → Junior rename (server/migrate-home.ts): ~/.triage moves to
 * ~/.junior with its databases renamed, old paths and tool names rewritten,
 * seeded files that were untouched kept untouched, and transcripts moved so
 * old chats resume.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrateHome, renameText } from '../server/migrate-home.js'

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
const key = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

function oldHome() {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'rename-'))
  const old = path.join(parent, '.triage')
  const ws = path.join(old, 'workspaces', 'w1')
  mkdirSync(path.join(ws, 'jobs'), { recursive: true })
  mkdirSync(path.join(ws, 'teams'), { recursive: true })
  writeFileSync(path.join(old, 'workspaces.json'), JSON.stringify({ workspaces: [{ id: 'w1', configDir: `${old}/workspaces/w1/claude` }] }))
  writeFileSync(path.join(ws, 'jobs', 'prs.md'), '---\nskills: [triage:pr-review]\ntools: [mcp__triage__list_work_items]\n---\nAsk Triage.\n')
  const seeded = '# Solo\nThe triage lead.\n'
  writeFileSync(path.join(ws, 'teams', 'solo.md'), seeded)
  writeFileSync(path.join(ws, 'teams', 'edited.md'), '# mine, triage\n')
  writeFileSync(path.join(ws, 'teams', '.seeded.json'), JSON.stringify({ version: 1, files: { 'teams/solo.md': { hash: hash(seeded) }, 'teams/edited.md': { hash: '0000000000000000' } } }))
  const cwd = `${old}/workspaces/w1/artifacts`
  const db = new DatabaseSync(path.join(ws, 'triage.db'))
  db.exec('CREATE TABLE sessions (id TEXT, cwd TEXT); CREATE TABLE config (key TEXT, value TEXT); CREATE TABLE projects (id TEXT, path TEXT); CREATE TABLE n (x INTEGER)')
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run('s1', cwd)
  db.prepare('INSERT INTO config VALUES (?, ?)').run('perms', JSON.stringify(['mcp__triage__get_today', `${old}/workspaces/w1`]))
  db.prepare('INSERT INTO n VALUES (?)').run(7)
  db.close()
  const claude = path.join(parent, '.claude')
  mkdirSync(path.join(claude, 'projects', key(cwd)), { recursive: true })
  return { parent, old, junior: path.join(parent, '.junior'), claude }
}

test('renameText keeps names that are not the product', () => {
  assert.equal(renameText('Triage triage TRIAGE novus-triage gh-triage'), 'Junior junior JUNIOR novus-triage gh-triage')
})

test('~/.triage becomes ~/.junior: folder, database, text, seeded files, transcripts', () => {
  const h = oldHome()
  const prev = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = h.claude
  try {
    migrateHome(h.junior)
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prev
  }
  const ws = path.join(h.junior, 'workspaces', 'w1')
  assert.equal(existsSync(h.old), false)
  assert.equal(existsSync(path.join(ws, 'junior.db')), true)
  assert.match(readFileSync(path.join(h.junior, 'workspaces.json'), 'utf8'), /\/\.junior\/workspaces\/w1\/claude/)

  const db = new DatabaseSync(path.join(ws, 'junior.db'))
  const cwd = (db.prepare('SELECT cwd FROM sessions').get() as { cwd: string }).cwd
  assert.equal(cwd, `${h.junior}/workspaces/w1/artifacts`)
  const perms = (db.prepare('SELECT value FROM config').get() as { value: string }).value
  assert.equal(perms, JSON.stringify(['mcp__junior__get_today', `${h.junior}/workspaces/w1`]))
  assert.equal((db.prepare('SELECT x FROM n').get() as { x: number }).x, 7)
  db.close()

  assert.equal(readFileSync(path.join(ws, 'jobs', 'prs.md'), 'utf8'), '---\nskills: [junior:pr-review]\ntools: [mcp__junior__list_work_items]\n---\nAsk Junior.\n')
  const manifest = JSON.parse(readFileSync(path.join(ws, 'teams', '.seeded.json'), 'utf8'))
  assert.equal(manifest.files['teams/solo.md'].hash, hash(readFileSync(path.join(ws, 'teams', 'solo.md'), 'utf8')), 'untouched stays untouched')
  assert.equal(manifest.files['teams/edited.md'].hash, '0000000000000000', 'edited stays edited')

  assert.equal(existsSync(path.join(h.claude, 'projects', key(cwd))), true)
})

test('nothing to do: no old folder, or ~/.junior already has a registry', () => {
  const h = oldHome()
  mkdirSync(h.junior)
  writeFileSync(path.join(h.junior, 'workspaces.json'), '{}')
  migrateHome(h.junior)
  assert.equal(existsSync(h.old), true)
  migrateHome(path.join(h.parent, 'not-a-home'))
})

test('the old server still running stops the move', () => {
  const h = oldHome()
  writeFileSync(path.join(h.old, 'server.json'), JSON.stringify({ pid: process.ppid }))
  assert.throws(() => migrateHome(h.junior), /old Triage server/)
  assert.equal(existsSync(h.old), true)
})

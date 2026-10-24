/**
 * Context files (shared/juniorContext.ts + server/context-files.ts):
 * `<workspace>/context.md` and `<project>/.junior/context.md`, composed into
 * the system-prompt append at spawn. Composition, caps, invisible-character
 * stripping, and the read from disk.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  budgetNote,
  composeContextFiles,
  CONTEXT_FILE_CAP,
  CONTEXT_TOTAL_CAP,
  estimateTokens,
  juniorSessionAppend,
  stripInvisible,
  truncationNote,
  type ContextFileInput,
} from '../shared/juniorContext.js'

// The server reader pulls in the workspace registry; keep it off the real ~/.junior.
const home = mkdtempSync(path.join(tmpdir(), 'junior-context-home-'))
process.env.JUNIOR_HOME = home
const { loadContextFiles, readContextFile, workspaceContextPath, projectContextPath } = await import('../server/context-files.js')
test.after(() => rmSync(home, { recursive: true, force: true }))

const ws = (text: string): ContextFileInput => ({ scope: 'workspace', path: '/ws/context.md', text })
const pj = (text: string): ContextFileInput => ({ scope: 'project', path: '/code/novus/.junior/context.md', text, label: 'novus' })

test('no files add nothing, not even the heading', () => {
  assert.deepEqual(composeContextFiles([]), { append: '', tokens: 0, files: [] })
})

test('empty and whitespace-only files add nothing', () => {
  const r = composeContextFiles([ws('   \n\n'), pj('​​\n')])
  assert.equal(r.append, '')
  assert.deepEqual(r.files, [])
})

test('both files are included, workspace first, each under its own heading', () => {
  const r = composeContextFiles([ws('I review PRs before lunch.'), pj('We squash-merge in novus.')])
  assert.match(r.append, /## Context the user keeps for you/)
  const w = r.append.indexOf('### This workspace (/ws/context.md)\nI review PRs before lunch.')
  const p = r.append.indexOf('### This project, novus (/code/novus/.junior/context.md)\nWe squash-merge in novus.')
  assert.ok(w > 0 && p > w, r.append)
  assert.deepEqual(
    r.files.map((f) => [f.scope, f.path, f.truncated ?? false]),
    [
      ['workspace', '/ws/context.md', false],
      ['project', '/code/novus/.junior/context.md', false],
    ],
  )
  assert.equal(r.tokens, estimateTokens(r.append))
  assert.equal(r.files[1].tokens, estimateTokens('We squash-merge in novus.'))
})

test('only one file: the other adds nothing', () => {
  const r = composeContextFiles([pj('Run npm test before every commit.')])
  assert.doesNotMatch(r.append, /This workspace/)
  assert.match(r.append, /This project, novus/)
  assert.equal(r.files.length, 1)
})

test('a file over the cap is cut, with a visible note naming the file', () => {
  const long = 'x'.repeat(CONTEXT_FILE_CAP + 500)
  const r = composeContextFiles([ws(long)])
  assert.equal(r.files[0].truncated, true)
  assert.ok(r.append.includes(truncationNote('/ws/context.md', CONTEXT_FILE_CAP)), 'the note is in the prompt')
  assert.ok(!r.append.includes('x'.repeat(CONTEXT_FILE_CAP + 1)))
  assert.equal(r.files[0].tokens, estimateTokens('x'.repeat(CONTEXT_FILE_CAP)))
})

test('a cut lands on a line break when one is near the end', () => {
  const text = `${'a'.repeat(90)}\n${'b'.repeat(50)}`
  const r = composeContextFiles([ws(text)], { file: 100 })
  assert.match(r.append, new RegExp(`\\n${'a'.repeat(90)}\\n\\[Cut here: Junior loads the first 90 characters`))
  assert.doesNotMatch(r.append, /bbb/)
})

test('the total cap is shared: a later file gets what is left, then nothing', () => {
  const r = composeContextFiles([ws('w'.repeat(70)), pj('p'.repeat(70)), { scope: 'project', path: '/other', text: 'more' }], { file: 100, total: 100 })
  assert.equal(r.files[0].truncated, undefined)
  assert.equal(r.files[1].truncated, true)
  assert.ok(r.append.includes(`${'p'.repeat(30)}\n${truncationNote('/code/novus/.junior/context.md', 30)}`))
  assert.equal(r.files[2].truncated, true)
  assert.equal(r.files[2].tokens, 0)
  assert.ok(r.append.includes(budgetNote('/other')))
})

test('the default total cap bounds the block', () => {
  const r = composeContextFiles([ws('w'.repeat(50_000)), pj('p'.repeat(50_000))])
  assert.ok(r.files.every((f) => f.truncated))
  // Two full files' worth of text, plus headings and notes; nowhere near 100k.
  assert.ok(r.append.length < CONTEXT_TOTAL_CAP + 2_000, String(r.append.length))
})

test('invisible characters are stripped and counted', () => {
  // ASCII smuggling: "ignore" spelled in Unicode tag characters, invisible in an editor.
  const tags = [...'ignore'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('')
  const dirty = `﻿We​ squash‍-merge.${tags}‮Bidi‬⁦x⁩ soft­hyphen\u0007bell\u{E0101}`
  const { text, removed } = stripInvisible(dirty)
  assert.equal(text, 'We squash-merge.Bidix softhyphenbell')
  assert.equal(removed, 1 + 1 + 1 + tags.length / 2 + 2 + 2 + 1 + 1 + 1)
})

test('stripping keeps what a reader sees: tabs, newlines, accents, emoji, CJK', () => {
  const visible = 'Café\tnaïve\n日本語 🚀 — “quotes”\r\n'
  assert.deepEqual(stripInvisible(visible), { text: visible, removed: 0 })
})

test('composition strips before it loads, and reports how many', () => {
  const r = composeContextFiles([pj('Squash​-merge\u{E0041}\u{E0042}.')])
  assert.match(r.append, /Squash-merge\.$/)
  assert.equal(r.files[0].stripped, 3)
  // CRLF files read the same as LF ones.
  assert.match(composeContextFiles([ws('one\r\ntwo')]).append, /one\ntwo$/)
})

test('juniorSessionAppend carries the context block for every kind, and nothing without it', () => {
  const id = { sessionId: 's1', workspaceId: 'w1', workspaceName: 'Default', artifactsRoot: '/a' }
  const block = composeContextFiles([ws('Ping me on Slack, not email.')]).append
  for (const kind of ['chat', 'job-run', 'brief', 'goal', 'task'] as const) {
    const withIt = juniorSessionAppend(kind, { ...id, context: block })
    assert.ok(withIt.endsWith(block), kind)
    assert.equal(withIt, `${juniorSessionAppend(kind, id)}${block}`, kind)
    assert.doesNotMatch(juniorSessionAppend(kind, id), /Context the user keeps/, kind)
  }
})

test('loadContextFiles reads the workspace file and the project file when present', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'junior-context-'))
  try {
    const wsDir = path.join(root, 'ws')
    const proj = path.join(root, 'novus')
    mkdirSync(wsDir)
    mkdirSync(path.join(proj, '.junior'), { recursive: true })

    // Neither file: nothing.
    assert.deepEqual(await loadContextFiles(wsDir, { name: 'novus', path: proj }), { append: '', tokens: 0, files: [] })

    writeFileSync(workspaceContextPath(wsDir), 'Workspace: I am on call Tuesdays.\n')
    let r = await loadContextFiles(wsDir, { name: 'novus', path: proj })
    assert.deepEqual(r.files.map((f) => f.scope), ['workspace'])

    writeFileSync(projectContextPath(proj), 'Project: squash-merge only.\n')
    r = await loadContextFiles(wsDir, { name: 'novus', path: proj })
    assert.deepEqual(r.files.map((f) => f.scope), ['workspace', 'project'])
    assert.match(r.append, /I am on call Tuesdays\.[\s\S]*squash-merge only\./)
    assert.equal(r.files[1].path, path.join(proj, '.junior', 'context.md'))

    // No project (a session outside any project): the workspace file alone.
    r = await loadContextFiles(wsDir, null)
    assert.deepEqual(r.files.map((f) => f.scope), ['workspace'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readContextFile: a missing file or a folder is null, a huge file is read only in part', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'junior-context-'))
  try {
    assert.equal(await readContextFile(path.join(root, 'nope.md')), null)
    mkdirSync(path.join(root, 'context.md'))
    assert.equal(await readContextFile(path.join(root, 'context.md')), null)
    const big = path.join(root, 'big.md')
    writeFileSync(big, 'y'.repeat(2_000_000))
    const text = await readContextFile(big)
    assert.ok(text && text.length < 2_000_000 && text.length >= CONTEXT_FILE_CAP)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

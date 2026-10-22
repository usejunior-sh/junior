/**
 * Jobs that use the browser (.docs/jobs.md → Browser): the `browser` and
 * `browser_sites` keys, the profile check at sync, the grants and the fence,
 * and the run prompt. The gate's own verdicts are tested with the gate.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkBrowserProfile, parseJobFile, serializeJobFile, type JobFileSpec } from '../server/job-files.js'
import { BROWSER_JOB_TOOLS, builtinGrant, runAllowedTools } from '../core/job/tools.js'
import { fenceDecision, fenceFor } from '../core/job/fence.js'
import { composeRunPrompt } from '../core/job/connectors.js'
import { defaultProfile, type BrowserProfile } from '../core/browser/profiles.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { openSqliteStore } from '../core/store/sqlite.js'

const ROOT = '/Users/me/Code/app'
const DOWNLOADS = '/Users/me/Downloads/Junior/run-1'

const spec: JobFileSpec = {
  id: 'j-1',
  title: 'Pendo guide stats',
  schedule: '0 9 * * 1',
  project: 'p-1',
  tools: [],
  output: 'digest',
  notify: 'on_failure',
  enabled: true,
  browser: { profile: 'pendo', sites: ['app.pendo.io', '*.pendo.io'] },
  instruction: "Summarise this week's guide stats from the Pendo dashboard.",
}

const file = (front: string) => `---\nid: j-2\nschedule: 0 9 * * 1\nproject: p-1\n${front}\n---\nRead the dashboard.\n`

test('browser and browser_sites survive the round trip', () => {
  const text = serializeJobFile(spec)
  assert.match(text, /^browser: pendo$/m)
  assert.match(text, /^browser_sites: \[app\.pendo\.io, "\*\.pendo\.io"\]$/m)
  const back = parseJobFile('pendo', text)
  assert.deepEqual(back.errors, [])
  assert.deepEqual(back.spec, spec)
})

test('a browser job needs no other tools; without the browser it still does', () => {
  assert.deepEqual(parseJobFile('a', file('tools: []\nbrowser: work')).errors, [])
  assert.match(parseJobFile('a', file('tools: []')).errors.join(), /at least one integration/)
})

test('browser_sites is optional, and checked', () => {
  assert.deepEqual(parseJobFile('a', file('browser: Work')).spec.browser, { profile: 'Work' })
  // as a person writes it, unquoted
  assert.deepEqual(parseJobFile('a', file('browser: work\nbrowser_sites: [*.pendo.io]')).spec.browser, { profile: 'work', sites: ['*.pendo.io'] })
  const bad = parseJobFile('a', file('browser: work\nbrowser_sites: [https://app.pendo.io/home, app.pendo.io]'))
  assert.equal(bad.errors.length, 1)
  assert.match(bad.errors[0], /"https:\/\/app\.pendo\.io\/home" is not a host/)
  assert.deepEqual(bad.spec.browser, { profile: 'work', sites: ['app.pendo.io'] })
  assert.match(parseJobFile('a', file('tools: [web]\nbrowser_sites: [app.pendo.io]')).errors.join(), /browser_sites needs browser/)
  assert.match(parseJobFile('a', file('tools: [web]\nbrowser: [a, b]')).errors.join(), /one profile/)
})

test('the profile is found by id or by name; an unknown one names Settings → Browser', () => {
  const pendo: BrowserProfile = { id: 'pendo', name: 'Pendo admin', color: 'blue', createdAt: 0, lastUsedAt: null }
  const list = [defaultProfile(), pendo]
  assert.equal(checkBrowserProfile({ profile: 'pendo' }, list).profile?.id, 'pendo')
  assert.equal(checkBrowserProfile({ profile: 'PENDO ADMIN' }, list).profile?.id, 'pendo')
  assert.equal(checkBrowserProfile({ profile: 'default' }, list).profile?.id, 'default')
  const miss = checkBrowserProfile({ profile: 'work' }, list)
  assert.equal(miss.profile, null)
  assert.match(miss.errors[0], /no profile named "work" \(Settings → Browser\)\. Profiles: Default, Pendo admin/)
  assert.deepEqual(checkBrowserProfile(undefined, list), { profile: null, errors: [] })
})

test('grants: the browser tools only for a browser job, never eval, checkpoint or compare', () => {
  assert.ok(!runAllowedTools([builtinGrant('web')], 'digest').some((t) => t.startsWith('mcp__browser__')))
  const allowed = runAllowedTools([], 'digest', true)
  for (const t of BROWSER_JOB_TOOLS) assert.ok(allowed.includes(t), t)
  for (const leaf of ['browser_eval', 'browser_checkpoint', 'browser_compare', 'browser_profiles']) {
    assert.ok(!allowed.includes(`mcp__browser__${leaf}`), leaf)
  }
})

test('fence: browser tools pass only when the job names a profile', () => {
  const plain = fenceFor([builtinGrant('web')], 'digest', ROOT)
  assert.ok(!fenceDecision(plain, 'mcp__browser__browser_snapshot', {}).allow)
  const f = fenceFor([], 'digest', ROOT, {}, { browser: true, readRoots: [DOWNLOADS] })
  assert.ok(fenceDecision(f, 'mcp__browser__browser_snapshot', {}).allow)
  assert.ok(fenceDecision(f, 'mcp__browser__browser_open', { url: 'https://app.pendo.io' }).allow)
  assert.ok(!fenceDecision(f, 'mcp__browser__browser_eval', { expression: 'document.cookie' }).allow)
  assert.ok(!fenceDecision(f, 'mcp__browser__browser_checkpoint', {}).allow)
})

test('fence: a browser run reads its downloads, and writes nothing there', () => {
  const f = fenceFor([builtinGrant('files-write')], 'digest', ROOT, {}, { browser: true, readRoots: [DOWNLOADS] })
  assert.ok(fenceDecision(f, 'Read', { file_path: `${DOWNLOADS}/report.csv` }).allow)
  assert.ok(fenceDecision(f, 'Grep', { pattern: 'x', path: DOWNLOADS }).allow)
  assert.ok(fenceDecision(f, 'Glob', { pattern: `${DOWNLOADS}/*.csv` }).allow)
  assert.ok(fenceDecision(f, 'Read', { file_path: 'src/a.ts' }).allow)
  assert.ok(!fenceDecision(f, 'Write', { file_path: `${DOWNLOADS}/x.md` }).allow)
  assert.ok(!fenceDecision(f, 'Read', { file_path: '/Users/me/Downloads/Junior/run-2/other.csv' }).allow)
  assert.ok(!fenceDecision(f, 'Read', { file_path: '/Users/me/Downloads/secret.pdf' }).allow)
  // without the browser, the downloads folder is outside like anything else
  assert.ok(!fenceDecision(fenceFor([builtinGrant('web')], 'digest', ROOT), 'Read', { file_path: `${DOWNLOADS}/report.csv` }).allow)
})

test('run prompt: names the profile and the sites, and that it can only read', () => {
  const p = composeRunPrompt({
    instruction: 'Summarise the guide stats.',
    tools: [],
    project: { name: 'app', path: ROOT },
    output: 'digest',
    lookbackMs: 7 * 86_400_000,
    nowIso: '2026-10-22T09:00:00.000Z',
    browser: { profile: 'Pendo admin', sites: ['app.pendo.io'] },
  })
  assert.match(p, /Integrations you may use: Browser\./)
  assert.match(p, /signed in as the user's "Pendo admin" profile/)
  assert.match(p, /You may open only app\.pendo\.io/)
  assert.match(p, /can't press Send, Submit, Save/)
  assert.match(p, /Never sign in or type a password/)
  const open = composeRunPrompt({ instruction: 'x', tools: [builtinGrant('web')], project: { name: 'app', path: ROOT }, lookbackMs: 1, nowIso: 'now', browser: { profile: 'Work' } })
  assert.match(open, /Integrations you may use: Web, Browser\./)
  assert.match(open, /You may open any site/)
  assert.doesNotMatch(composeRunPrompt({ instruction: 'x', tools: [builtinGrant('web')], project: { name: 'app', path: ROOT }, lookbackMs: 1, nowIso: 'now' }), /Browser/)
})

test('a job keeps its browser through create, update and clear (temp store, never ~/.junior)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'junior-job-browser-'))
  const store = openSqliteStore(path.join(dir, 'junior.db'))
  try {
    const { jobs } = store
    await jobs.create({
      id: 'w1', source: 'slack', title: 'W', scope: '', instruction: 'x', cadence: 'daily', schedule: '0 9 * * *',
      enabled: true, createsItems: true, tools: [], projectId: 'p', output: 'digest', notify: 'on_failure',
      consecutiveFailures: 0, browser: { profile: 'pendo', sites: ['app.pendo.io'] }, createdAt: 1, updatedAt: 1,
    })
    const stored = await jobs.get('w1')
    assert.deepEqual(stored?.browser, { profile: 'pendo', sites: ['app.pendo.io'] })
    // no tools but the browser: never read back as a legacy Slack job
    assert.deepEqual(stored?.tools, [])
    const allowed = runAllowedTools(stored!.tools, 'digest', true).filter((t) => t.startsWith('mcp__'))
    assert.deepEqual(allowed.sort(), ['mcp__junior__write_digest', ...BROWSER_JOB_TOOLS].sort())
    await jobs.update('w1', { browser: { profile: 'work' } })
    assert.deepEqual((await jobs.get('w1'))?.browser, { profile: 'work' })
    await jobs.update('w1', { title: 'W2' })
    assert.deepEqual((await jobs.get('w1'))?.browser, { profile: 'work' })
    await jobs.update('w1', { browser: null })
    assert.equal((await jobs.get('w1'))?.browser, undefined)
  } finally {
    await store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

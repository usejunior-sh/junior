/**
 * The curated job templates (server/jobs/templates.ts): each parses under the
 * strict job file schema, ships off, grants no send tool, and none of them is
 * an impact-notes or brag-doc job. Files live in a temp dir, never ~/.junior.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CURATED_TEMPLATES, curatedTemplateFiles } from '../server/jobs/templates.js'
import { JobFiles, parseJobFile, serializeJobFile } from '../server/job-files.js'
import { isSendTool, readbackOf } from '../core/job/readback.js'
import { isValidCron } from '../core/job/cron.js'

const files = curatedTemplateFiles('p-1')

test('the three chores, by file name, with stable template ids', () => {
  assert.deepEqual(Object.keys(files).sort(), ['dependency-prs', 'flaky-tests', 'release-notes'])
  for (const [name, spec] of Object.entries(files)) {
    assert.equal(spec.id, `template-${name}`)
    assert.equal(spec.project, 'p-1')
  }
})

test('every template parses under the strict schema, round-trips, and is off', () => {
  for (const [name, spec] of Object.entries(files)) {
    const parsed = parseJobFile(name, serializeJobFile(spec))
    assert.deepEqual(parsed.errors, [], name)
    assert.equal(parsed.spec.enabled, false, `${name} must ship off`)
    assert.deepEqual(parsed.spec, spec, name)
    assert.ok(isValidCron(spec.schedule), name)
    assert.ok(spec.budgetUsd && spec.dailyBudgetUsd, `${name} has a per-run and a daily budget`)
  }
})

test('no template grants a send tool, or file writes: it reads and files to the inbox only', () => {
  for (const [name, spec] of Object.entries(files)) {
    for (const g of spec.tools) {
      assert.notEqual(g.source.kind === 'builtin' && g.source.id, 'files-write', `${name} must not write files`)
      for (const tool of g.tools) {
        if (g.source.kind === 'mcp') assert.equal(isSendTool(tool), false, `${name} grants ${tool}, a send`)
        assert.ok(!/gh api|merge|close|comment|edit|create/.test(tool), `${name} grants ${tool}`)
      }
    }
    const rows = readbackOf(spec, { file: `jobs/${name}.md`, projectName: 'repo' }).rows
    assert.equal(rows.find((r) => r.label === 'Sends')?.value, 'none', name)
    assert.equal(rows.find((r) => r.label === 'Writes')?.value, 'nothing', name)
  }
})

test('the release notes are one private digest, not a send', () => {
  assert.equal(CURATED_TEMPLATES['release-notes'].output, 'digest')
  assert.match(CURATED_TEMPLATES['release-notes'].instruction, /nothing is published/)
})

test('no impact-notes or brag-doc template is seeded', () => {
  for (const [name, t] of Object.entries(CURATED_TEMPLATES)) {
    assert.ok(!/impact|brag/i.test(`${name} ${t.title} ${t.instruction}`), name)
  }
})

test('seeding writes each one off, and the jobs folder reads them back clean', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'junior-job-templates-'))
  try {
    const jobs = new JobFiles(root)
    await jobs.seed(curatedTemplateFiles(''))
    for (const name of Object.keys(CURATED_TEMPLATES)) {
      const parsed = parseJobFile(name, readFileSync(jobs.pathOf(name), 'utf8'))
      assert.deepEqual(parsed.errors, [], name)
      assert.equal(parsed.spec.enabled, false, name)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * A drafted job's read-back (job-readback-steps): the rows the chat shows
 * under draft_job are built from the file's grants, never from model prose,
 * and the job chat's instruction asks for numbered steps before a trial.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReadback, readbackOf, readbackText, type ReadbackSpec } from '../core/job/readback.js'
import { builtinGrant, mcpToolName, presetGrant, type JobToolGrant } from '../core/job/tools.js'
import { JOBS_SECTION } from '../shared/juniorContext.js'
import { draftJobText } from '../server/jobs/ops.js'

const ctx = { file: 'jobs/sentry-errors.md', projectName: 'acme/web' }
const spec = (over: Partial<ReadbackSpec> = {}): ReadbackSpec => ({ schedule: '0 9 * * 1-5', tools: [builtinGrant('web')], output: 'items', ...over })
const mcp = (server: string, ...tools: string[]): JobToolGrant => ({
  source: { kind: 'mcp', server, scope: 'claudeai' },
  tools: tools.map((t) => mcpToolName(server, t)),
})
const row = (r: ReturnType<typeof readbackOf>, label: string) => r.rows.find((x) => x.label === label)

test('the smallest job: reads the web and its code, writes nothing, sends none', () => {
  const r = readbackOf(spec(), ctx)
  assert.deepEqual(r, {
    file: 'jobs/sentry-errors.md',
    rows: [
      { label: 'Reads', value: 'the web, code in acme/web' },
      { label: 'Writes', value: 'nothing', quiet: true },
      { label: 'Sends', value: 'none', quiet: true },
      { label: 'Files', value: 'one item per match, in your inbox' },
      { label: 'Runs', value: 'Weekdays at 9:00 AM. Off until you turn it on.' },
    ],
  })
})

test('a read-only preset reads, and sends none', () => {
  const r = readbackOf(spec({ tools: [presetGrant('claude.ai Slack')!] }), ctx)
  assert.equal(row(r, 'Reads')?.value, 'Slack, code in acme/web')
  assert.equal(row(r, 'Sends')?.value, 'none')
})

test('a send tool in the grants is read back as a send, held for you', () => {
  const g = presetGrant('claude.ai Slack')!
  g.tools.push(mcpToolName('claude.ai Slack', 'slack_send_message'))
  const r = readbackOf(spec({ tools: [g] }), ctx)
  assert.equal(row(r, 'Reads')?.value, 'Slack, code in acme/web')
  assert.equal(row(r, 'Sends')?.value, 'Slack messages. Held for you.')
  assert.equal(row(r, 'Sends')?.quiet, undefined)
})

test('two kinds on one server join with "and"; servers with only sends are not in Reads', () => {
  const r = readbackOf(spec({ tools: [builtinGrant('github'), mcp('claude.ai Linear', 'save_issue', 'update_issue')] }), ctx)
  assert.equal(row(r, 'Reads')?.value, 'GitHub (read only), code in acme/web')
  assert.equal(row(r, 'Sends')?.value, 'Linear tickets and updates. Held for you.')
})

test('an unknown verb counts as a send: the words never promise less than the gate', () => {
  const r = readbackOf(spec({ tools: [mcp('Sentry', 'list_issues', 'frobnicate_issue')] }), ctx)
  assert.equal(row(r, 'Reads')?.value, 'Sentry, code in acme/web')
  assert.equal(row(r, 'Sends')?.value, 'Sentry changes. Held for you.')
})

test('files-write writes in the project; the web and GitHub lead Reads', () => {
  const r = readbackOf(spec({ tools: [mcp('Sentry', 'list_issues'), builtinGrant('files-write'), builtinGrant('github'), builtinGrant('web')] }), ctx)
  assert.equal(row(r, 'Writes')?.value, 'files in acme/web')
  assert.equal(row(r, 'Reads')?.value, 'the web, GitHub (read only), Sentry, code in acme/web')
})

test('browser row: only when set, with or without sites', () => {
  assert.equal(row(readbackOf(spec(), ctx), 'Browser'), undefined)
  const one = readbackOf(spec({ browser: { profile: 'Work', sites: ['app.datadoghq.com'] } }), ctx)
  assert.equal(row(one, 'Browser')?.value, 'pages on app.datadoghq.com, as Work. The browser gate checks each step.')
  const any = readbackOf(spec({ browser: { profile: 'Work' } }), ctx)
  assert.equal(row(any, 'Browser')?.value, 'any page, as Work. The browser gate checks each step.')
  assert.deepEqual(any.rows.map((x) => x.label), ['Reads', 'Writes', 'Sends', 'Browser', 'Files', 'Runs'])
})

test('files: digest, and items with a brief', () => {
  assert.equal(row(readbackOf(spec({ output: 'digest' }), ctx), 'Files')?.value, 'one digest, updated each run')
  assert.equal(row(readbackOf(spec({ brief: {} }), ctx), 'Files')?.value, 'one item per match, each with a brief')
})

test('the text round-trips through the strip parser', () => {
  const g = presetGrant('claude.ai Slack')!
  g.tools.push(mcpToolName('claude.ai Slack', 'slack_send_message'))
  for (const s of [spec(), spec({ tools: [g, builtinGrant('files-write')], browser: { profile: 'Work', sites: ['a.com', 'b.com'] }, output: 'digest' })]) {
    const r = readbackOf(s, ctx)
    assert.deepEqual(parseReadback(`ok: drafted\nsome line\n${readbackText(r)}`), r)
  }
})

test('no block, or a cut one, parses to null: never a half ledger', () => {
  assert.equal(parseReadback('ok: drafted the job “x”.\nReview and enable: #/jobs/abc'), null)
  const cut = readbackText(readbackOf(spec(), ctx)).split('\n').slice(0, 3).join('\n')
  assert.equal(parseReadback(cut), null)
})

test('draft_job’s result ends with the read-back, built from the file', () => {
  const readback = readbackOf(spec(), ctx)
  const text = draftJobText({ id: 'j1', title: 'Sentry errors', file: ctx.file, warnings: [], readback }, true)
  assert.ok(text.includes('#/jobs/j1'))
  assert.deepEqual(parseReadback(text), readback)
  assert.match(text, /numbered list/)
  assert.ok(text.indexOf('numbered list') < text.indexOf('Call try_job only after they say yes'))
  // an older shape, without a read-back, still reads
  assert.equal(parseReadback(draftJobText({ id: 'j1', title: 'x', file: ctx.file, warnings: [] })), null)
})

test('the job chat asks for numbered steps and one question before the trial run', () => {
  const steps = JOBS_SECTION.indexOf('numbered')
  assert.ok(steps > 0)
  assert.ok(steps < JOBS_SECTION.indexOf('Call try_job only after they say yes'))
  assert.ok(JOBS_SECTION.indexOf('After draft_job, send ONE message before any trial run') > JOBS_SECTION.indexOf('Draft it with draft_job'))
  assert.match(JOBS_SECTION, /Each run will:/)
  assert.match(JOBS_SECTION, /Run a trial now\? It files and sends nothing\. Suggested: yes\./)
  assert.match(JOBS_SECTION, /Don't restate what it may touch or when it runs/)
  assert.doesNotMatch(JOBS_SECTION, /24\/7|walk away/)
  // the section, as written: a change to the instruction is a change to this snapshot
  const step45 = JOBS_SECTION.slice(JOBS_SECTION.indexOf('4. After draft_job'))
  assert.equal(
    step45,
    `4. After draft_job, send ONE message before any trial run. Write what each run does as a numbered
   list: 3 to 6 steps, in order, one short sentence each, starting with a verb; the last step says
   what it files. Open it with "Each run will:". Don't restate what it may touch or when it runs:
   draft_job shows the user those lines from the file, under the call. End with one question and
   your suggested answer: "Run a trial now? It files and sends nothing. Suggested: yes."
5. Call try_job only after they say yes, so they see what it would file before they turn it on.`,
  )
})

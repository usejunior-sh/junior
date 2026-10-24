/**
 * applyOffers (core/junior/onboarding.ts): Junior's first message applies the
 * ticked rows through the existing ops, in order, and only those. The ops are
 * a fixture api that records every call.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstRunOffers, type FirstRunState } from '../core/junior/offers.js'
import { applyOffers, defaultPicks, jobToolLines, onboardRows, replyLine, rowVerb, NEEDS_PROJECT, type OnboardApi } from '../core/junior/onboarding.js'

const project = (name: string) => ({ path: `/Users/me/Code/${name}`, name, repo: `acme/${name}`, why: '4 sessions, last today' })

const STATE: FirstRunState = {
  ghLogin: 'samar',
  connectors: [
    { name: 'Slack', server: 'claude.ai Slack', status: 'connected' },
    { name: 'Sentry', server: 'claude.ai Sentry', status: 'connected' },
    { name: 'Acme Docs', server: 'acme-docs', status: 'connected' },
  ],
  suggestions: [project('api'), project('web'), project('cli'), project('dotfiles')],
  watches: { babysit: false, review: false },
  caps: { perDayUsd: 20, perReviewUsd: 1 },
  jobs: [],
}

type Call = [string, ...unknown[]]

function fixture(opts: { fail?: Record<string, string>; jobs?: Array<{ id: string; file?: string }>; tools?: Record<string, string[]> } = {}) {
  const calls: Call[] = []
  const fail = (what: string) => {
    if (opts.fail?.[what]) throw new Error(opts.fail[what])
  }
  const api: OnboardApi = {
    async addProject(p) {
      calls.push(['addProject', p.name, p.makeDefault])
      fail(`project:${p.name}`)
      return { id: `id-${p.name}` }
    },
    async turnOnWatch(w) {
      calls.push(['turnOnWatch', w])
      fail(w)
    },
    async listJobs() {
      calls.push(['listJobs'])
      return opts.jobs ?? [{ id: 'template-slack', file: 'slack' }]
    },
    async enableJob(id) {
      calls.push(['enableJob', id])
      fail(`enable:${id}`)
    },
    async draftJob(d) {
      calls.push(['draftJob', d.title, d.project, d.tools])
      fail(`draft:${d.title}`)
    },
    toolsFor(server) {
      return opts.tools?.[server] ?? [`${server}/search`]
    },
  }
  return { api, calls }
}

test('onboardRows: one row per project, watch and job, pre-ticked to each offer’s default', () => {
  const rows = onboardRows(firstRunOffers(STATE))
  assert.deepEqual(
    rows.map((r) => r.key),
    ['project:/Users/me/Code/api', 'project:/Users/me/Code/web', 'project:/Users/me/Code/cli', 'project:/Users/me/Code/dotfiles', 'babysit', 'review', 'job:claude.ai Slack', 'job:claude.ai Sentry', 'job:acme-docs'],
  )
  assert.deepEqual(
    [...defaultPicks(rows)],
    ['project:/Users/me/Code/api', 'project:/Users/me/Code/web', 'project:/Users/me/Code/cli', 'babysit', 'review', 'job:claude.ai Slack', 'job:claude.ai Sentry'],
  )
})

test('applyOffers: nothing picked, nothing called', async () => {
  const rows = onboardRows(firstRunOffers(STATE))
  const { api, calls } = fixture()
  const r = await applyOffers(rows, new Set(), api)
  assert.deepEqual(calls, [])
  assert.deepEqual(r.rows, {})
})

test('applyOffers: the defaults run projects, then watches, then jobs; the first project is the default', async () => {
  const rows = onboardRows(firstRunOffers(STATE))
  const { api, calls } = fixture()
  const seen: string[] = []
  const r = await applyOffers(rows, defaultPicks(rows), api, { onRow: (k, s) => seen.push(`${k}=${s}`) })
  assert.deepEqual(calls, [
    ['addProject', 'api', true],
    ['addProject', 'web', false],
    ['addProject', 'cli', false],
    ['turnOnWatch', 'babysit'],
    ['turnOnWatch', 'review'],
    ['listJobs'],
    ['enableJob', 'template-slack'],
    ['draftJob', 'Sentry', 'id-api', ['claude.ai Sentry/search']],
  ])
  assert.equal(r.project, 'id-api')
  assert.ok(Object.values(r.rows).every((x) => x.state === 'done'))
  assert.equal(r.rows['job:claude.ai Sentry']?.drafted, true)
  assert.equal(r.rows['job:claude.ai Slack']?.drafted, undefined)
  assert.ok(seen.indexOf('babysit=running') < seen.indexOf('babysit=done'))
  assert.equal(replyLine(rows, r), 'Done. Added 3 projects. Babysitting is on. Reviews are on. The Slack job is on. Drafted 1 job. It stays off until you try a run.')
})

test('applyOffers: unticked rows are never applied', async () => {
  const rows = onboardRows(firstRunOffers(STATE))
  const { api, calls } = fixture()
  await applyOffers(rows, new Set(['project:/Users/me/Code/dotfiles', 'review']), api)
  assert.deepEqual(calls, [
    ['addProject', 'dotfiles', true],
    ['turnOnWatch', 'review'],
  ])
})

test('applyOffers: a job with no project fails with "Needs a project" and calls nothing', async () => {
  const rows = onboardRows(firstRunOffers(STATE))
  const { api, calls } = fixture()
  const r = await applyOffers(rows, new Set(['babysit', 'job:claude.ai Sentry']), api)
  assert.deepEqual(calls, [['turnOnWatch', 'babysit']])
  assert.deepEqual(r.rows['job:claude.ai Sentry'], { state: 'fail', error: NEEDS_PROJECT })
})

test('applyOffers: a failed row keeps going, and Try again reruns only it with the earlier project', async () => {
  const rows = onboardRows(firstRunOffers(STATE))
  const first = fixture({ fail: { 'project:web': 'folder is gone', review: 'HTTP 500', 'draft:Sentry': 'bad cron' } })
  const r1 = await applyOffers(rows, defaultPicks(rows), first.api)
  const failed = Object.entries(r1.rows).filter(([, v]) => v.state === 'fail').map(([k]) => k)
  assert.deepEqual(failed, ['project:/Users/me/Code/web', 'review', 'job:claude.ai Sentry'])
  assert.equal(r1.rows.review?.error, 'HTTP 500')
  assert.equal(replyLine(rows, r1), '3 didn’t work. The rest is set up. Added 2 projects. Babysitting is on. The Slack job is on.')

  const again = fixture()
  const r2 = await applyOffers(rows, new Set(failed), again.api, { project: r1.project })
  assert.deepEqual(again.calls, [
    ['addProject', 'web', false],
    ['turnOnWatch', 'review'],
    ['draftJob', 'Sentry', 'id-api', ['claude.ai Sentry/search']],
  ])
  assert.ok(Object.values(r2.rows).every((x) => x.state === 'done'))
})

test('applyOffers: a library job with no seeded file is drafted instead', async () => {
  const rows = onboardRows(firstRunOffers(STATE))
  const { api, calls } = fixture({ jobs: [] })
  const r = await applyOffers(rows, new Set(['project:/Users/me/Code/api', 'job:claude.ai Slack']), api)
  assert.deepEqual(calls.at(-1), ['draftJob', 'Slack', 'id-api', ['claude.ai Slack/search']])
  assert.equal(r.rows['job:claude.ai Slack']?.drafted, true)
})

test('applyOffers: a source with no read tools fails its row, not the run', async () => {
  const rows = onboardRows(firstRunOffers(STATE))
  const { api, calls } = fixture({ tools: { 'acme-docs': [] } })
  const r = await applyOffers(rows, new Set(['project:/Users/me/Code/api', 'job:acme-docs']), api)
  assert.equal(calls.length, 1)
  assert.equal(r.rows['job:acme-docs']?.state, 'fail')
  assert.match(r.rows['job:acme-docs']?.error ?? '', /Set it up from Jobs/)
})

test('jobToolLines: preset, then read-only marks, then read-looking names', () => {
  const t = (name: string, extra: object = {}) => ({ name, fullName: `mcp__x__${name}`, ...extra })
  assert.ok(jobToolLines('claude.ai Slack', []).includes('claude.ai Slack/slack_read_thread'))
  assert.deepEqual(jobToolLines('docs', [t('search_pages', { readOnly: true }), t('create_page')]), ['docs/search_pages'])
  assert.deepEqual(jobToolLines('docs', [t('search_pages'), t('create_page'), t('get_page')]), ['docs/search_pages', 'docs/get_page'])
  assert.deepEqual(jobToolLines('docs', [t('create_page')]), [])
})

test('rowVerb: each kind’s words per state', () => {
  assert.deepEqual(
    (['idle', 'running', 'done', 'fail'] as const).map((s) => rowVerb({ kind: 'project' }, s)),
    ['Add', 'Adding…', 'Added', 'Didn’t work'],
  )
  assert.equal(rowVerb({ kind: 'watch' }, 'done'), 'On')
  assert.equal(rowVerb({ kind: 'job', library: 'slack' }, 'idle'), 'Turn on')
  assert.equal(rowVerb({ kind: 'job' }, 'idle'), 'Draft, off')
  assert.equal(rowVerb({ kind: 'job' }, 'running'), 'Drafting…')
})

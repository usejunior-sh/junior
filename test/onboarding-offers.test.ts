/**
 * firstRunOffers (core/junior/offers.ts): what Junior offers on day one, from
 * the gh login, the connectors the probe found, suggested projects and the
 * watch switches. Pure: the same state always gives the same offers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstRunOffers, starterFor, wordCount, type FirstRunOffer, type FirstRunState } from '../core/junior/offers.js'

const project = (name: string) => ({ path: `/Users/me/Code/${name}`, name, repo: `acme/${name}`, why: '4 Claude Code sessions, last today' })
const conn = (name: string, extra: Partial<FirstRunState['connectors'][number]> = {}) => ({
  name,
  server: `claude.ai ${name}`,
  status: 'connected',
  ...extra,
})

const EMPTY: FirstRunState = {
  ghLogin: null,
  connectors: [],
  suggestions: [],
  watches: { babysit: false, review: false },
  caps: { perDayUsd: 20, perReviewUsd: 1 },
  jobs: [],
}

const ids = (o: FirstRunOffer[]) => o.map((x) => x.id)

test('firstRunOffers: a table of detected states and the offers they give', () => {
  const rows: Array<{ name: string; state: Partial<FirstRunState>; want: string[] }> = [
    { name: 'nothing detected', state: {}, want: [] },
    { name: 'gh only: both watches', state: { ghLogin: 'samar' }, want: ['babysit', 'review'] },
    { name: 'gh, babysitting already on', state: { ghLogin: 'samar', watches: { babysit: true, review: false } }, want: ['review'] },
    { name: 'gh, both on', state: { ghLogin: 'samar', watches: { babysit: true, review: true } }, want: [] },
    { name: 'no gh: no watch offers even when off', state: { suggestions: [project('api')] }, want: ['projects'] },
    {
      name: 'the full first run, in order',
      state: {
        ghLogin: 'samar',
        suggestions: [project('api'), project('web')],
        connectors: [conn('Zendesk Tools'), conn('Sentry'), conn('PagerDuty'), conn('Linear')],
      },
      want: ['projects', 'babysit', 'review', 'job:claude.ai Linear', 'job:claude.ai PagerDuty', 'job:claude.ai Sentry', 'job:claude.ai Zendesk Tools'],
    },
    {
      name: 'connectors that are not sources are skipped',
      state: {
        ghLogin: 'samar',
        watches: { babysit: true, review: true },
        connectors: [
          conn('Notion', { status: 'needs-auth' }),
          { name: 'junior', server: 'junior', status: 'connected' },
          conn('GitHub'),
          { name: 'chrome-devtools', server: 'chrome-devtools', status: 'connected', tools: [{ openWorld: false }, { openWorld: false }] },
          conn('Sentry', { tools: [{ openWorld: false }, {}] }),
        ],
      },
      want: ['job:claude.ai Sentry'],
    },
    { name: 'a GitHub MCP server is a source when gh is not signed in', state: { connectors: [conn('GitHub')] }, want: ['job:claude.ai GitHub'] },
    {
      name: 'a source an enabled job already reads gets no offer; a disabled job does not count',
      state: {
        connectors: [conn('Slack'), conn('Linear')],
        jobs: [
          { enabled: true, servers: ['claude.ai Slack'] },
          { enabled: false, servers: ['claude.ai Linear'] },
        ],
      },
      want: ['job:claude.ai Linear'],
    },
  ]
  for (const r of rows) {
    const state = { ...EMPTY, ...r.state }
    assert.deepEqual(ids(firstRunOffers(state)), r.want, r.name)
    // the same state, the same answer: nothing else goes in
    assert.deepEqual(firstRunOffers(state), firstRunOffers(structuredClone(state)), `${r.name} (stable)`)
  }
})

test('firstRunOffers: each detected connector gets one offer; one with no starter gets the generic one', () => {
  const connectors = [conn('Sentry'), conn('PagerDuty'), conn('Linear'), conn('Slack'), conn('Notion'), conn('Acme Deploy Bot')]
  const offers = firstRunOffers({ ...EMPTY, connectors }).filter((o) => o.kind === 'job')
  assert.equal(offers.length, connectors.length)
  for (const c of connectors) assert.equal(offers.filter((o) => o.kind === 'job' && o.server === c.server).length, 1, c.name)
  const byName = new Map(offers.map((o) => [o.kind === 'job' ? o.name : '', o]))
  const generic = byName.get('Acme Deploy Bot')!
  assert.ok(generic.kind === 'job')
  assert.equal(generic.template.id, 'generic')
  assert.equal(generic.default, false, 'a source Junior has no starter for is offered, not pre-ticked')
  assert.match(generic.line, /^Watch Acme Deploy Bot for anything that needs you\.$/)
  assert.match(generic.say, /^New job: .*Acme Deploy Bot \(claude\.ai Acme Deploy Bot\)/)
  assert.match(generic.say, /Save it off/)
  const sentry = byName.get('Sentry')!
  assert.ok(sentry.kind === 'job')
  assert.equal(sentry.template.id, 'sentry')
  assert.equal(sentry.default, true)
  // Slack's starter is the seeded library's job: turned on, not drafted again
  const slack = byName.get('Slack')!
  assert.ok(slack.kind === 'job')
  assert.equal(slack.template.library, 'slack')
  assert.match(slack.say, /^Turn on the Slack job/)
})

test('firstRunOffers: the same source twice (claude.ai and local) is one offer', () => {
  const offers = firstRunOffers({ ...EMPTY, connectors: [conn('Linear'), { name: 'linear', server: 'linear', status: 'connected' }] })
  assert.deepEqual(ids(offers), ['job:claude.ai Linear'])
})

test('firstRunOffers: every offer has a default and a line of 15 words or fewer', () => {
  const offers = firstRunOffers({
    ...EMPTY,
    ghLogin: 'samar',
    caps: { perDayUsd: 12.5, perReviewUsd: 0.75 },
    suggestions: [project('api'), project('web'), project('cli'), project('docs')],
    connectors: ['Slack', 'Linear', 'Jira', 'PagerDuty', 'Sentry', 'Rollbar', 'Notion', 'Gmail', 'A Very Long Internal Incident Console Name'].map((n) => conn(n)),
  })
  assert.equal(offers.length, 3 + 9)
  for (const o of offers) {
    assert.equal(typeof o.default, 'boolean', o.id)
    assert.ok(o.line.length > 0, o.id)
    assert.ok(wordCount(o.line) <= 15, `${o.id}: "${o.line}" is ${wordCount(o.line)} words`)
    assert.ok(!/24\/7|walk away/i.test(o.line + (o.kind === 'job' ? o.say : '')), o.id)
  }
  const babysit = offers.find((o) => o.id === 'babysit')!
  assert.ok(babysit.kind === 'watch')
  assert.equal(babysit.capText, 'Up to $12.50 a day')
  const review = offers.find((o) => o.id === 'review')!
  assert.ok(review.kind === 'watch')
  assert.equal(review.capText, 'Up to $0.75 a review')
})

test('firstRunOffers: the top three suggested projects are pre-ticked', () => {
  const [one] = firstRunOffers({ ...EMPTY, suggestions: [project('a'), project('b'), project('c'), project('d')] })
  assert.ok(one?.kind === 'projects')
  assert.deepEqual(one.projects.map((p) => p.default), [true, true, true, false])
  assert.equal(one.line, 'Add the 3 repos where you run Claude Code most.')
  const [single] = firstRunOffers({ ...EMPTY, suggestions: [project('a')] })
  assert.equal(single?.line, 'Add the repo where you run Claude Code most.')
})

test('starterFor: known sources by name, any case; the rest generic', () => {
  assert.equal(starterFor('pagerduty').template.id, 'pagerduty')
  assert.equal(starterFor('Atlassian').template.id, 'jira')
  assert.equal(starterFor('Datadog').template.id, 'generic')
  assert.equal(starterFor('Datadog').known, false)
})

/**
 * core/babysit/ci.ts + snapshot.ts: the PR reading babysitting uses (moved out
 * of the old goals engine, move-goal-helpers). The flake test, the bot-comment
 * fingerprint, the fix cap and the snapshot parse behave as they did.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkFrom, fingerprint, looksFlaky, MAX_FIX_ATTEMPTS } from '../core/babysit/ci.js'
import { snapshotFrom, type PrRef } from '../core/babysit/snapshot.js'

const PR: PrRef = { repo: 'acme/app', number: 12 }

test('looksFlaky: timeouts, dropped connections and lost runners; not a real failure', () => {
  for (const log of ['Error: ETIMEDOUT', 'socket hang up', 'The job timed out', 'HTTP 503 Service Unavailable', 'The runner has received a shutdown signal', 'flaky test retried'])
    assert.equal(looksFlaky(log), true, log)
  for (const log of ['AssertionError: expected 2, got 3', 'Type error in src/a.ts', 'exit code 1']) assert.equal(looksFlaky(log), false, log)
})

test('fingerprint: the same finding prints the same across runs', () => {
  const a = fingerprint({ author: 'CodeRabbitAI[bot]', path: 'src/a.ts', body: 'Possible null deref on line 42 (abc1234)' })
  const b = fingerprint({ author: 'coderabbitai[bot]', path: 'src/a.ts', body: 'Possible  null deref on line 57 (def5678)' })
  assert.equal(a, b)
  assert.notEqual(a, fingerprint({ author: 'coderabbitai[bot]', path: 'src/b.ts', body: 'Possible null deref on line 42' }))
  assert.equal(fingerprint({ author: 'x', path: null, body: '' }), 'x||')
})

test('the fix cap is three', () => {
  assert.equal(MAX_FIX_ATTEMPTS, 3)
})

test('checkFrom folds check runs and status contexts; anything else is null', () => {
  assert.deepEqual(checkFrom({ __typename: 'CheckRun', databaseId: 5, name: 'test', status: 'COMPLETED', conclusion: 'SKIPPED', detailsUrl: null, checkSuite: null }), {
    name: 'test',
    status: 'neutral',
    id: '5',
    runId: null,
    url: null,
    conclusion: 'SKIPPED',
  })
  assert.equal(checkFrom({ __typename: 'StatusContext', id: 'S', context: 'ci', state: 'ERROR', targetUrl: 'u', createdAt: 't' })?.status, 'failure')
  assert.equal(checkFrom({ __typename: 'StatusContext', id: 'S', context: 'ci', state: 'PENDING', targetUrl: 'u', createdAt: 't' })?.status, 'pending')
  assert.equal(checkFrom({ __typename: 'Other' }), null)
})

test('snapshotFrom reads what gh hands back', () => {
  const s = snapshotFrom(PR, {
    data: {
      repository: {
        pullRequest: {
          url: 'u',
          state: 'MERGED',
          headRefOid: 'abc',
          headRefName: 'h',
          baseRefName: 'main',
          mergeable: 'WHATEVER',
          reviewDecision: 'APPROVED',
          timelineItems: { nodes: [{ actor: { login: 'samar' } }] },
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        { __typename: 'CheckRun', databaseId: 5, name: 'test', status: 'COMPLETED', conclusion: 'TIMED_OUT', detailsUrl: 'd', checkSuite: { workflowRun: { databaseId: 77 } } },
                        { __typename: 'StatusContext', id: 'S', context: 'vercel', state: 'SUCCESS', targetUrl: null, createdAt: 't' },
                      ],
                    },
                  },
                },
              },
            ],
          },
          reviewThreads: { nodes: [{ id: 'T', isResolved: true, path: null, comments: { nodes: [{ url: 'c', body: 'b', author: { __typename: 'User', login: 'dependabot[bot]' } }] } }] },
        },
      },
    },
  })
  assert.equal(s.state, 'MERGED')
  assert.equal(s.mergeable, 'UNKNOWN')
  assert.equal(s.reviewDecision, 'APPROVED')
  assert.equal(s.closedBy, 'samar')
  assert.deepEqual(
    s.checks.map((c) => [c.name, c.status, c.runId, c.conclusion]),
    [
      ['test', 'failure', 77, 'TIMED_OUT'],
      ['vercel', 'success', null, 'SUCCESS'],
    ],
  )
  assert.deepEqual(s.threads[0], { id: 'T', author: 'dependabot[bot]', isBot: true, resolved: true, path: null, body: 'b', url: 'c' })
  assert.throws(() => snapshotFrom(PR, { data: { repository: { pullRequest: null } } }), /not found/)
})

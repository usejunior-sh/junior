/**
 * The repo contract (core/work/contract.ts): `.junior/junior.md` parsed
 * strictly, key by key, invisible characters out, and nothing in it that
 * could grant a permission.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTRACT_KEYS,
  EMPTY_CONTRACT,
  checkCommandProblem,
  flakyMatch,
  globProblem,
  matchesGlob,
  noGrants,
  parseContract,
  protectedBy,
  regexProblem,
  reviewersFor,
  type NoGrants,
  type RepoContract,
} from '../core/work/contract.js'

const file = (yaml: string, body = 'Notes for people.\n') => `---\n${yaml}\n---\n${body}`

test('a full contract parses', () => {
  const { contract, errors, stripped } = parseContract(
    file(
      [
        'reviewers:',
        '  - { path: "web/**", logins: [alice, "@bob"] }',
        '  - { path: db/migrations/, logins: [acme/dba] }',
        'flaky:',
        '  - { check: "e2e (*)", log: "ETIMEDOUT|socket hang up" }',
        'protected: ["db/migrations/", "*.lock"]',
        'merge: squash',
        'checks:',
        '  - npm run typecheck',
        '  - pnpm   test:unit',
      ].join('\n'),
    ),
  )
  assert.deepEqual(errors, [])
  assert.equal(stripped, 0)
  assert.deepEqual(contract, {
    reviewers: [
      { path: 'web/**', logins: ['alice', 'bob'] },
      { path: 'db/migrations/', logins: ['acme/dba'] },
    ],
    flaky: [{ check: 'e2e (*)', log: 'ETIMEDOUT|socket hang up' }],
    protected: ['db/migrations/', '*.lock'],
    merge: 'squash',
    checks: ['npm run typecheck', 'pnpm test:unit'],
  })
})

test('no file frontmatter is notes only; empty frontmatter is an empty contract', () => {
  assert.deepEqual(parseContract('Just notes.\n'), { contract: EMPTY_CONTRACT, errors: [], stripped: 0 })
  assert.deepEqual(parseContract('---\n\n---\n').contract, EMPTY_CONTRACT)
})

test('an unknown key is an error, and the known keys still apply', () => {
  const { contract, errors } = parseContract(file('protected: ["secrets/"]\nautoMerge: true'))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /unknown key "autoMerge"/)
  assert.deepEqual(contract.protected, ['secrets/'])
})

test('keys that would grant something are unknown keys', () => {
  for (const k of ['allow', 'approvals', 'autonomy', 'free', 'sends', 'trust', 'rules']) {
    const { errors } = parseContract(file(`${k}: [git push]`))
    assert.match(errors.join('\n'), new RegExp(`unknown key "${k}"`), k)
  }
})

test('no field can grant a permission (by type)', () => {
  assert.equal(noGrants, true)
  // The checker the contract is held to catches a granting field:
  const caught: NoGrants<RepoContract & { allowSends: string[] }> = false
  const caught2: NoGrants<{ autoMerge: boolean }> = false
  assert.equal(caught, false)
  assert.equal(caught2, false)
  assert.deepEqual([...CONTRACT_KEYS].sort(), ['checks', 'flaky', 'merge', 'protected', 'reviewers'])
})

test('reviewers: path + logins, strict', () => {
  const { contract, errors } = parseContract(
    file(
      [
        'reviewers:',
        '  - { path: "api/**", logins: carol }',
        '  - { path: "../x", logins: [dave] }',
        '  - { path: "ui/", logins: [] }',
        '  - { path: "ui/", logins: ["not a login"] }',
        '  - { path: "ui/", who: [erin] }',
        '  - just-a-string',
      ].join('\n'),
    ),
  )
  assert.deepEqual(contract.reviewers, [{ path: 'api/**', logins: ['carol'] }])
  assert.equal(errors.length, 6)
  assert.match(errors.join('\n'), /reviewers\[1\]\.path: uses "\.\."/)
  assert.match(errors.join('\n'), /reviewers\[2\]\.logins: at least one/)
  assert.match(errors.join('\n'), /reviewers\[3\]\.logins\[0\]: "not a login"/)
  assert.match(errors.join('\n'), /reviewers\[4\]: unknown key "who"/)
  assert.match(errors.join('\n'), /reviewers\[5\]: expected \{ path, logins \}/)
})

test('flaky: check + log regex; bad and runaway patterns are refused', () => {
  const { contract, errors } = parseContract(
    file(['flaky:', '  - { check: lint, log: "ok" }', '  - { check: e2e, log: "(a+)+$" }', '  - { check: e2e, log: "[" }', '  - { check: "", log: "x" }', '  - { check: e2e, log: x, retry: 3 }'].join('\n')),
  )
  assert.deepEqual(contract.flaky, [{ check: 'lint', log: 'ok' }, { check: 'e2e', log: 'x' }])
  assert.equal(errors.length, 4)
  assert.match(errors.join('\n'), /flaky\[1\]\.log: a repeated group/)
  assert.match(errors.join('\n'), /flaky\[2\]\.log: not a valid regular expression/)
  assert.match(errors.join('\n'), /flaky\[3\]\.check/)
  assert.match(errors.join('\n'), /flaky\[4\]: unknown key "retry"/)
  assert.equal(regexProblem('\\1'), 'back-references are not supported')
})

test('protected: globs only add protection', () => {
  const { contract, errors } = parseContract(file(['protected:', '  - "*.lock"', '  - "!vendor/"', '  - "src/[ab].ts"', '  - "/"', '  - infra/'].join('\n')))
  assert.deepEqual(contract.protected, ['*.lock', 'infra/'])
  assert.equal(errors.length, 3)
  assert.match(globProblem('!vendor/') ?? '', /take protection away/)
  // A single string is a list of one.
  assert.deepEqual(parseContract(file('protected: infra/')).contract.protected, ['infra/'])
  assert.match(parseContract(file('protected: { a: b }')).errors[0], /protected: expected a list/)
})

test('merge: one of squash, merge, rebase', () => {
  for (const m of ['squash', 'merge', 'rebase'] as const) assert.equal(parseContract(file(`merge: ${m}`)).contract.merge, m)
  const bad = parseContract(file('merge: fast-forward'))
  assert.equal(bad.contract.merge, null)
  assert.match(bad.errors[0], /merge: one of squash, merge, rebase/)
})

test('checks: one plain local command each; nothing outbound', () => {
  const { contract, errors } = parseContract(
    file(['checks:', '  - npm test', '  - cargo test --all', '  - ./scripts/check.sh', '  - git push', '  - "npm test && curl x"', '  - npm publish', '  - "echo ${{ secrets.TOKEN }}"', '  - npx eslint .'].join('\n')),
  )
  assert.deepEqual(contract.checks, ['npm test', 'cargo test --all', './scripts/check.sh'])
  assert.equal(errors.length, 5)
  assert.equal(checkCommandProblem('curl https://x'), 'curl is not a check')
  assert.equal(checkCommandProblem('pnpm dlx foo'), 'pnpm dlx is not a check')
  assert.equal(checkCommandProblem('/usr/bin/make test'), 'runs a program outside the repo')
  assert.equal(checkCommandProblem('FOO=1 npm test'), 'one plain command only: no shell operators, quotes or variables')
  assert.equal(checkCommandProblem('make test'), 'make is not a check')
})

test('invisible characters are taken out before parsing', () => {
  const zw = '​'
  const tag = String.fromCodePoint(0xe0041)
  const { contract, errors, stripped } = parseContract(`﻿---\nprotected: ["sec${zw}rets/"]\nme${tag}rge: squash\n---\n`)
  assert.deepEqual(errors, [])
  assert.deepEqual(contract.protected, ['secrets/'])
  assert.equal(contract.merge, 'squash')
  assert.equal(stripped, 2)
})

test('a broken frontmatter is an error and an empty contract', () => {
  const r = parseContract('---\nprotected: [a\n---\n')
  assert.deepEqual(r.contract, EMPTY_CONTRACT)
  assert.match(r.errors[0], /unclosed/)
})

test('globs: *, **, ?, any depth, anchored, folders cover their files', () => {
  assert.equal(matchesGlob('package-lock.json', '*.json'), true)
  assert.equal(matchesGlob('web/package-lock.json', '*.json'), true)
  assert.equal(matchesGlob('web/a.json', '/*.json'), false)
  assert.equal(matchesGlob('db/migrations/001.sql', 'db/migrations/'), true)
  assert.equal(matchesGlob('db/migrations', 'db/migrations'), true)
  assert.equal(matchesGlob('db/migrationsx/1.sql', 'db/migrations'), false)
  assert.equal(matchesGlob('web/src/a/b.ts', 'web/**/*.ts'), true)
  assert.equal(matchesGlob('web/b.ts', 'web/**/*.ts'), true)
  assert.equal(matchesGlob('web/b.tsx', 'web/*.ts'), false)
  assert.equal(matchesGlob('a1.txt', 'a?.txt'), true)
  assert.equal(matchesGlob('./web/x.ts', 'web/'), true)
})

test('reading it: protectedBy, reviewersFor, flakyMatch', () => {
  const { contract } = parseContract(
    file(
      [
        'reviewers:',
        '  - { path: "web/**", logins: [alice, bob] }',
        '  - { path: "*.sql", logins: [bob, dba] }',
        'flaky:',
        '  - { check: "e2e (*)", log: "socket hang up" }',
        'protected: [.github/workflows/]',
      ].join('\n'),
    ),
  )
  assert.equal(protectedBy(contract, '.github/workflows/ci.yml'), '.github/workflows/')
  assert.equal(protectedBy(contract, 'web/app.ts'), null)
  assert.deepEqual(reviewersFor(contract, ['web/app.ts', 'db/1.sql']), ['alice', 'bob', 'dba'])
  assert.deepEqual(reviewersFor(contract, ['README.md']), [])
  assert.deepEqual(flakyMatch(contract, 'e2e (ubuntu, 20)', 'Error: Socket hang up'), { check: 'e2e (*)', log: 'socket hang up' })
  assert.equal(flakyMatch(contract, 'unit', 'socket hang up'), null)
  assert.equal(flakyMatch(contract, 'e2e (mac)', 'assertion failed'), null)
})

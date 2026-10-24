/**
 * Which of a failing CI job's steps Junior runs locally before it pushes a
 * fix (core/babysit/ci-steps.ts), how the fix-ci prompt names them
 * (core/babysit/brief.ts), and the disk reader (server/babysit/ci-steps.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { findCiJob, isInstall, localChecks, matrixCombos, workingDirs, type CiJob, type WorkflowFile } from '../core/babysit/ci-steps.js'
import { CHECKED_LOCALLY, localChecksSection, taskPrompt, type TaskPr } from '../core/babysit/brief.js'
import type { ItemTask } from '../core/work/tasks.js'
import { readLocalChecks } from '../server/babysit/ci-steps.js'

const CI = `
name: ci
on: [push, pull_request]
jobs:
  check:
    name: Typecheck and test
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22.x }
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - name: Lint
        run: pnpm run lint
`

const MATRIX = `
name: test
on: pull_request
jobs:
  unit:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [20, 22]
        exclude:
          - os: macos-latest
            node: 20
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run test:unit -- --shard=\${{ matrix.node }}
  e2e:
    name: E2E (\${{ matrix.browser }})
    strategy:
      matrix:
        browser: [chromium, webkit]
    defaults:
      run:
        working-directory: web
    steps:
      - run: yarn test:e2e --project=\${{ matrix.browser }}
  dynamic:
    strategy:
      matrix: \${{ fromJSON(needs.plan.outputs.matrix) }}
    steps:
      - run: npm test
`

const RELEASE = `
name: release
on: push
jobs:
  ship:
    name: Release
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run build
      - run: make release
      - run: npx semantic-release
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
      - run: docker push acme/api:latest
      - run: aws s3 sync dist s3://acme-site
      - run: gh release create v1.0.0
      - name: Test with a token
        run: npm test
        env:
          NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
      - run: npm test | tee out.txt
      - run: npm run deploy
      - run: npm run build && curl -X POST https://hooks.acme.dev
  reuse:
    uses: acme/workflows/.github/workflows/test.yml@main
`

const files: WorkflowFile[] = [
  { path: '.github/workflows/ci.yml', text: CI },
  { path: '.github/workflows/test.yml', text: MATRIX },
  { path: '.github/workflows/release.yml', text: RELEASE },
]

const SCRIPTS: Record<string, string[]> = { '': ['test', 'test:unit', 'typecheck', 'lint', 'build', 'deploy'], web: ['test:e2e'] }
const scriptsIn = (d: string) => SCRIPTS[d] ?? null

const job = (check: string, declared: string[] = []): CiJob => {
  const r = localChecks(files, check, scriptsIn, declared)
  assert.ok(r.job, `expected a job for ${check}: ${'why' in r ? r.why : ''}`)
  return r.job
}
const runnable = (j: CiJob) => j.steps.filter((s) => s.runnable).map((s) => s.command)

test('a job is found by its name, or by its id when it has none', () => {
  assert.equal(job('Typecheck and test').jobId, 'check')
  assert.equal(job('Release').jobId, 'ship')
  assert.equal(job('ci / Typecheck and test').jobId, 'check')
  const miss = localChecks(files, 'Deploy preview', scriptsIn)
  assert.equal(miss.job, null)
  assert.match('why' in miss ? miss.why : '', /no job in \.github\/workflows is named "Deploy preview"/)
  assert.deepEqual(localChecks([], 'test', scriptsIn), { job: null, why: 'the repo has no workflow files' })
})

test('a matrix job is found by the name GitHub gives each combo', () => {
  const u = job('unit (ubuntu-latest, 20)')
  assert.equal(u.jobId, 'unit')
  assert.deepEqual(u.matrix, { os: 'ubuntu-latest', node: '20' })
  assert.deepEqual(runnable(u), ['npm run test:unit -- --shard=20'])
  const e = job('E2E (webkit)')
  assert.equal(e.jobId, 'e2e')
  assert.deepEqual(e.matrix, { browser: 'webkit' })
  assert.deepEqual(e.steps.map((s) => [s.command, s.cwd, s.runnable]), [['yarn test:e2e --project=webkit', 'web', true]])
})

test("a matrix Junior can't spell out still finds the job, but its matrix values stay unknown", () => {
  const d = job('dynamic (linux, 3)')
  assert.equal(d.jobId, 'dynamic')
  assert.equal(d.matrix, undefined)
  assert.deepEqual(runnable(d), ['npm test'])
  const p = findCiJob(files, 'unit (macos-latest, 20)')
  assert.ok(!('why' in p) && p.jobId === 'unit' && p.combo === undefined)
  const shard = localChecks(files, 'unit (macos-latest, 20)', scriptsIn).job!.steps.find((s) => s.command?.includes('test:unit'))
  assert.equal(shard?.runnable, false)
  assert.equal(shard?.why, 'uses a CI expression Junior can fill in only on CI')
})

test('matrix combos: product, exclude, include extends or adds', () => {
  assert.deepEqual(matrixCombos({}), [])
  assert.deepEqual(matrixCombos({ strategy: { matrix: '${{ x }}' } }), null)
  assert.deepEqual(
    matrixCombos({ strategy: { matrix: { os: ['a', 'b'], node: [1], include: [{ os: 'a', extra: 'y' }, { os: 'c', node: 2 }], exclude: [{ os: 'b' }] } } }),
    [{ os: 'a', node: '1', extra: 'y' }, { os: 'c', node: '2' }],
  )
})

test('npm test, pnpm run lint and npm run typecheck run when package.json has the scripts', () => {
  const j = job('Typecheck and test')
  assert.deepEqual(runnable(j), ['npm run typecheck', 'npm test', 'pnpm run lint'])
  const ci = j.steps.find((s) => s.command === 'npm ci')
  assert.deepEqual([ci?.runnable, ci?.setup], [false, true])
  assert.deepEqual(j.steps.filter((s) => s.uses).map((s) => [s.label, s.why]), [
    ['actions/checkout@v4', 'an action, not a command'],
    ['actions/setup-node@v4', 'an action, not a command'],
  ])
})

test("a check script package.json doesn't have is skipped", () => {
  const j = localChecks(files, 'Typecheck and test', (d) => (d === '' ? ['test'] : null)).job!
  assert.deepEqual(runnable(j), ['npm test'])
  assert.equal(j.steps.find((s) => s.command === 'npm run typecheck')?.why, 'package.json has no "typecheck" script')
  const none = localChecks(files, 'Typecheck and test', () => null).job!
  assert.deepEqual(runnable(none), [])
  assert.equal(none.steps.find((s) => s.command === 'npm test')?.why, 'no package.json where it runs')
})

test('release, deploy and cloud steps are skipped and listed as skipped', () => {
  const j = job('Release')
  const why = Object.fromEntries(j.steps.filter((s) => !s.runnable).map((s) => [s.label, s.why]))
  assert.deepEqual(runnable(j), ['npm run build'])
  assert.equal(why['make release'], 'runs make, not a check script')
  assert.equal(why['npx semantic-release'], 'names a secret')
  assert.equal(why['docker push acme/api:latest'], 'runs docker, not a check script')
  assert.equal(why['aws s3 sync dist s3://acme-site'], 'runs aws, not a check script')
  assert.equal(why['gh release create v1.0.0'], 'runs gh, not a check script')
  assert.equal(why['Test with a token'], 'names a secret')
  assert.equal(why['npm test | tee out.txt'], 'uses shell beyond a plain command')
  assert.equal(why['npm run deploy'], '"deploy" is not a check script')
  assert.equal(why['npm run build && curl -X POST https://hooks.acme.dev'], 'runs curl, not a check script')
  // without the secret, semantic-release is still not a check
  const bare = localChecks([{ path: 'a.yml', text: 'jobs:\n  r:\n    steps:\n      - run: npx semantic-release\n' }], 'r', scriptsIn).job!
  assert.equal(bare.steps[0]?.why, 'runs npx, not a check script')
  const reuse = job('reuse')
  assert.deepEqual(reuse.steps.map((s) => [s.runnable, s.why]), [[false, 'a reusable workflow, its steps live elsewhere']])
})

test("a command the repo declares as a check runs as written, unless it names a secret", () => {
  const text = 'jobs:\n  t:\n    steps:\n      - run: make test\n      - run: make test SECRET=${{ secrets.X }}\n'
  const j = localChecks([{ path: 'a.yml', text }], 't', scriptsIn, ['make  test']).job!
  assert.deepEqual(j.steps.map((s) => s.runnable), [true, false])
})

test('multi-line run steps run only when every line is a check or an install', () => {
  const text = 'jobs:\n  t:\n    steps:\n      - run: |\n          npm ci\n          # lint first\n          npm run lint && npm test\n      - run: |\n          npm test\n          ./scripts/upload.sh\n'
  const j = localChecks([{ path: 'a.yml', text }], 't', scriptsIn).job!
  assert.deepEqual(j.steps.map((s) => [s.command, s.runnable]), [
    ['npm ci && npm run lint && npm test', true],
    ['npm test && ./scripts/upload.sh', false],
  ])
})

test('script names: a check or a check prefix; plain arguments only', () => {
  const run = (cmd: string, scripts = ['test', 'test:unit', 'testing', 'format:check', 'lint-staged', 'check', 'build']) =>
    localChecks([{ path: 'a.yml', text: `jobs:\n  t:\n    steps:\n      - run: ${JSON.stringify(cmd)}\n` }], 't', () => scripts).job!.steps[0]!.runnable
  assert.equal(run('npm run test:unit'), true)
  assert.equal(run('yarn format:check'), true)
  assert.equal(run('pnpm check'), true)
  assert.equal(run('npm run testing'), false)
  assert.equal(run('npm run lint-staged'), false)
  assert.equal(run('npm build'), false, 'npm needs run for anything but test')
  assert.equal(run('npm test -- --coverage'), true)
  assert.equal(run('npm test -- $HOME'), false)
  assert.equal(run('CI=1 npm test'), false)
  assert.equal(run('npm test; rm -rf /'), false)
  assert.equal(run('npm test &'), false)
})

test('installs are setup, not checks; installing a package is neither', () => {
  assert.equal(isInstall('npm ci'), true)
  assert.equal(isInstall('pnpm install --frozen-lockfile'), true)
  assert.equal(isInstall('yarn'), true)
  assert.equal(isInstall('yarn --immutable'), true)
  assert.equal(isInstall('npm install -g semantic-release'), false)
  assert.equal(isInstall('yarn add left-pad'), false)
})

test('working dirs: the root, job defaults and step folders, never outside the repo', () => {
  const text = 'jobs:\n  a:\n    defaults: { run: { working-directory: ./web/ } }\n    steps:\n      - run: x\n        working-directory: api\n      - run: y\n        working-directory: ../up\n'
  assert.deepEqual(workingDirs([{ path: 'a.yml', text }]), ['', 'web', 'api'])
})

test('unreadable workflow files are a reason, not a crash', () => {
  assert.deepEqual(localChecks([{ path: 'bad.yml', text: 'jobs: [: oops' }], 'x', scriptsIn), { job: null, why: 'no workflow file could be read' })
  assert.deepEqual(localChecks(files, ' ', scriptsIn), { job: null, why: 'the failing check has no name' })
})

const pr: TaskPr = { repo: 'acme/api', number: 12, url: 'https://github.com/acme/api/pull/12', headRef: 'feat/retries', baseRef: 'main' }
const fixCi = (check: string): ItemTask => ({
  id: 't1',
  itemId: 'github:acme/api#12',
  title: `Fix ${check}`,
  owner: 'junior',
  state: 'running',
  why: 'event',
  attempts: 1,
  createdAt: 0,
  step: 'fix-ci',
  input: { check, sha: 'abc1234def', attempt: 1, url: 'https://ci/x' },
})

test('the fix-ci prompt names only the runnable steps (snapshot)', () => {
  const p = taskPrompt(fixCi('Typecheck and test'), pr, undefined, { log: 'src/a.ts(3): error TS2304', diff: '+const x = y', local: localChecks(files, 'Typecheck and test', scriptsIn) })
  assert.equal(
    p,
    `You are Junior, babysitting the user's PR acme/api#12 (https://github.com/acme/api/pull/12) until it's ready for review. One task this session: **Fix Typecheck and test**.

## How you work here
- This folder is your own worktree, on a local branch made from origin/feat/retries. The user's checkout is never touched.
- Push with \`git push origin HEAD:feat/retries\` (after a rebase: \`git push --force-with-lease origin HEAD:feat/retries\`). Those run without asking. Plain --force, other branches and implicit pushes are refused.
- Anything else that reaches a person (a PR comment, a reviewer request, marking ready, a merge) is held for the user's OK. Don't try those here.
- Keep the change to what the task needs. One commit with a plain message is best.

## The task
CI check "Typecheck and test" fails on the PR's head (abc1234). Fix it. This is fix 1 of 3; after that the user is asked.
Check: https://ci/x

Find the cause in the log, fix it here, check it locally (below), commit, and push. Fix the cause, not the test: don't skip, weaken or delete a test to make it pass. If the failure isn't caused by this PR, don't change anything: hand in blocked and say why.

### Check locally before you push
The check is the job \`check\` in .github/workflows/ci.yml.
Run these steps here, in order, before you push. Push only once they pass. If this worktree has no dependencies yet, install them first the way CI does (\`npm ci\`).
1. \`npm run typecheck\`
2. \`npm test\`
3. \`pnpm run lint\`

Skipped, not a check (don't run these: they may deploy, publish or need CI's secrets):
- actions/checkout@v4 (an action, not a command)
- actions/setup-node@v4 (an action, not a command)

In your done line, say "Checked locally with the CI job's steps" when they pass. If one can't run here (it needs a service or a tool CI has), push anyway and say "Not checked locally" and why.

### Failing log
\`\`\`
src/a.ts(3): error TS2304
\`\`\`

### The PR diff
\`\`\`diff
+const x = y
\`\`\`

## When you finish
Call \`submit_task\` once:
- \`done\`, with one line on what you changed ("removed the unused import in api.ts") and the commit you pushed, or
- \`blocked\`, with the question the user has to answer.
Add \`decisions\` for anything the next task on this PR should know.`,
  )
})

test('the release job: one runnable step, the rest listed as skipped (snapshot)', () => {
  assert.equal(
    localChecksSection(localChecks(files, 'Release', scriptsIn)).join('\n'),
    `### Check locally before you push
The check is the job \`ship\` in .github/workflows/release.yml.
Run these steps here, in order, before you push. Push only once they pass. If this worktree has no dependencies yet, install them first.
1. \`npm run build\`

Skipped, not a check (don't run these: they may deploy, publish or need CI's secrets):
- actions/checkout@v4 (an action, not a command)
- make release (runs make, not a check script)
- npx semantic-release (names a secret)
- docker push acme/api:latest (runs docker, not a check script)
- aws s3 sync dist s3://acme-site (runs aws, not a check script)
- gh release create v1.0.0 (runs gh, not a check script)
- Test with a token: \`npm test\` (names a secret)
- npm test | tee out.txt (uses shell beyond a plain command)
- npm run deploy ("deploy" is not a check script)
- npm run build && curl -X POST https://hooks.acme.dev (runs curl, not a check script)

In your done line, say "${CHECKED_LOCALLY}" when they pass. If one can't run here (it needs a service or a tool CI has), push anyway and say "Not checked locally" and why.`,
  )
})

test("the prompt says why it couldn't check locally (snapshot)", () => {
  assert.equal(
    localChecksSection(localChecks(files, 'reuse', scriptsIn)).join('\n'),
    `### Check locally before you push
The check is the job \`reuse\` in .github/workflows/release.yml.
None of its steps is a plain check you may run on this Mac, so don't run them. Push your fix and let CI check it.

Skipped, not a check:
- calls acme/workflows/.github/workflows/test.yml@main (a reusable workflow, its steps live elsewhere)

In your done line, say "Not checked locally: the CI job has no plain check steps".`,
  )
  assert.equal(
    localChecksSection({ job: null, why: 'the repo has no workflow files' }).join('\n'),
    `### Check locally before you push
The CI job behind this check wasn't found: the repo has no workflow files. Don't run CI's own steps by hand. If package.json has a test or lint script, run it here before you push.
In your done line, say "${CHECKED_LOCALLY}" only if you ran them; otherwise say "Not checked locally" and why.`,
  )
})

test('without local checks, the fix-ci prompt keeps its old line', () => {
  const p = taskPrompt(fixCi('lint'), pr, undefined, { log: 'x' })
  assert.match(p, /run the check locally if you can/)
  assert.doesNotMatch(p, /Check locally before you push/)
})

test("the disk reader reads a worktree's workflows and package.json scripts", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-steps-'))
  try {
    mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true })
    mkdirSync(path.join(dir, 'web'))
    writeFileSync(path.join(dir, '.github', 'workflows', 'test.yml'), MATRIX)
    writeFileSync(path.join(dir, '.github', 'workflows', 'notes.txt'), 'not a workflow')
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'node --test' } }))
    writeFileSync(path.join(dir, 'web', 'package.json'), '{ broken')
    const u = await readLocalChecks(dir, 'unit (ubuntu-latest, 22)')
    assert.deepEqual(u.job && runnable(u.job), ['npm run test:unit -- --shard=22'])
    const e = await readLocalChecks(dir, 'E2E (chromium)')
    assert.equal(e.job?.steps[0]?.why, 'no package.json where it runs')
    assert.deepEqual(await readLocalChecks(path.join(dir, 'web'), 'x'), { job: null, why: 'the repo has no workflow files' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

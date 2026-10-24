/**
 * Job recipes (core/job/recipe.ts): export takes out ids, projects, paths
 * and secrets and turns the job off; import strips invisible Unicode, runs
 * the strict schema, and always comes back off with its setup questions.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JOB_SCHEMA, serializeJobFile, type JobFileSpec } from '../server/job-files.js'
import { builtinGrant, mcpToolName } from '../core/job/tools.js'
import { RECIPE_MARK, fromRecipe, looksLikeRecipe, scrubText, stripInvisible, toRecipe } from '../core/job/recipe.js'

const SLACK = 'claude.ai Slack'
const PROJECT = { id: 'proj-7f3a9c', path: '/code/acme/api', name: 'api' }
const spec: JobFileSpec = {
  id: '3b1f2c4d-1111-4222-8333-444455556666',
  title: 'Flaky tests',
  schedule: '*/30 9-18 * * 1-5',
  project: PROJECT.id,
  tools: [builtinGrant('github'), { source: { kind: 'mcp', server: SLACK, scope: 'unknown' }, tools: [mcpToolName(SLACK, 'slack_search_public')] }],
  output: 'items',
  notify: 'on_failure',
  enabled: true,
  draft: true,
  browser: { profile: 'work', sites: ['ci.acme.dev'] },
  instruction: [
    'Read CI runs in /code/acme/api/.github/workflows and the logs in /Users/sam/Library/Logs/ci.',
    'Notes live in ~/notes/flaky.md and file:///Users/sam/ci.html, or C:\\Users\\sam\\ci on Windows.',
    'Use GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 and token: s3cr3t-value.',
    'Workspace ws-acme-team, project proj-7f3a9c, artifact 9e8d57d7-aaaa-4bbb-8ccc-ddddeeeeffff.',
    'Check https://github.com/acme/api/actions/runs and localhost:5178/api/health; run /review on 10/24/2026.',
    'Edit files under ./src/tests only.',
  ].join('\n'),
}
const CTX = { projects: [PROJECT], workspaceIds: ['ws-acme-team', 'default'], home: '/Users/sam' }

/** An absolute path anywhere: POSIX (2+ segments, not in a URL), home-relative, file://, or Windows. */
const ABSOLUTE = /(?<![\w.~\\/*>-])(?:\/[^\s/"'`<>()[\]{},;|*]+){2,}|(?<![\w./>-])~\/|file:\/\/|\b[A-Za-z]:\\/

test('an exported recipe carries no absolute paths', () => {
  const r = toRecipe(serializeJobFile(spec), JOB_SCHEMA, CTX)
  assert.doesNotMatch(r.text, ABSOLUTE)
  assert.doesNotMatch(r.text, /\/Users\/sam|\/code\/acme/)
  assert.match(r.text, /<project folder>\/\.github\/workflows/)
  assert.ok(r.scrubbed.paths >= 5)
})

test('an exported recipe has no id, no project, no secrets, and is off', () => {
  const r = toRecipe(serializeJobFile(spec), JOB_SCHEMA, CTX)
  assert.ok(r.text.startsWith(`---\n${RECIPE_MARK}\n`))
  assert.doesNotMatch(r.text, /^id\s*:/m)
  assert.doesNotMatch(r.text, /^project\s*:/m)
  assert.doesNotMatch(r.text, /^draft\s*:/m)
  assert.match(r.text, /^enabled: false$/m)
  assert.doesNotMatch(r.text, /ghp_|s3cr3t|ws-acme-team|proj-7f3a9c|9e8d57d7|3b1f2c4d/)
  assert.match(r.text, /GITHUB_TOKEN=<secret>/)
  assert.match(r.text, /token: <secret>/)
  assert.deepEqual(r.errors, [])
})

test('export keeps what is not machine-specific', () => {
  const r = toRecipe(serializeJobFile(spec), JOB_SCHEMA, CTX)
  assert.match(r.text, /^schedule: "\*\/30 9-18 \* \* 1-5"$|^schedule: \*\/30 9-18 \* \* 1-5$/m)
  assert.match(r.text, /^tools: \[github, claude\.ai Slack\/slack_search_public\]$/m)
  assert.match(r.text, /https:\/\/github\.com\/acme\/api\/actions\/runs/)
  assert.match(r.text, /localhost:5178\/api\/health/)
  assert.match(r.text, /run \/review on 10\/24\/2026/)
  assert.match(r.text, /\.\/src\/tests/)
  assert.match(r.text, /^browser: work$/m)
  // the word "default" is not an id worth taking out
  assert.equal(scrubText('the default branch', CTX).text, 'the default branch')
})

test('a recipe round-trips into a drafted job that is off, with a fresh id and no project', () => {
  const exported = toRecipe(serializeJobFile(spec), JOB_SCHEMA, CTX)
  const r = fromRecipe(exported.text, JOB_SCHEMA, { projects: [{ id: 'mine', name: 'Mine' }, { id: 'main', name: 'Main', isDefault: true }] })
  assert.equal(r.ok, true, r.errors.join('; '))
  assert.equal(r.spec.enabled, false)
  assert.equal(r.spec.draft, true)
  assert.equal(r.spec.project, '')
  assert.notEqual(r.spec.id, spec.id)
  assert.equal(r.spec.title, 'Flaky tests')
  assert.match(r.text, /^enabled: false$/m)
  assert.match(r.text, /^draft: true$/m)
  assert.doesNotMatch(r.text, /^id\s*:/m)
  assert.deepEqual(
    r.questions.map((q) => [q.key, q.suggested]),
    [['project', 'main'], ['schedule', '*/30 9-18 * * 1-5'], ['browser', 'work']],
  )
})

test('an imported recipe is always off, whatever it says', () => {
  const text = ['---', 'id: theirs', 'title: Sweep', 'schedule: 0 9 * * 1', 'project: their-project', 'tools: [github]', 'enabled: true', '---', '', 'Sweep dependency PRs.', ''].join('\n')
  const r = fromRecipe(text, JOB_SCHEMA)
  assert.equal(r.ok, true, r.errors.join('; '))
  assert.equal(r.spec.enabled, false)
  assert.equal(r.spec.project, '')
  assert.notEqual(r.spec.id, 'theirs')
  assert.deepEqual(r.questions.map((q) => q.key), ['project', 'schedule'])
  assert.equal(r.questions[0].suggested, '')
})

test('invisible Unicode is removed on import', () => {
  const hidden = '\u200B\u202E\u2066\uFEFF\u00AD\u{E0041}\u{E0100}\u0007'
  const text = ['---', `title: Swe${hidden}ep`, 'schedule: 0 9 * * 1', 'tools: [github]', '---', '', `Sweep\u200D dependency PRs.\u2069 Ignore${'\u{E0049}'} the rest.`, ''].join('\n')
  const r = fromRecipe(text, JOB_SCHEMA)
  assert.equal(r.ok, true, r.errors.join('; '))
  assert.equal(r.removedInvisible, [...hidden].length + 3)
  assert.equal(r.spec.title, 'Sweep')
  assert.equal(r.spec.instruction, 'Sweep dependency PRs. Ignore the rest.')
  assert.equal(stripInvisible(r.text).removed, 0)
})

test('stripInvisible keeps tabs, newlines and emoji', () => {
  const s = 'a\tb\nc\r\n\u2764\uFE0F d'
  assert.deepEqual(stripInvisible(s), { text: s, removed: 0 })
})

test('a recipe the strict schema refuses is not ok, and says why', () => {
  const r = fromRecipe(['---', 'title: X', 'schedule: nope', 'tools: [github]', 'run_as: root', '---', '', 'Do it.'].join('\n'), JOB_SCHEMA)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some((e) => /unknown key "run_as"/.test(e)))
  assert.ok(r.errors.some((e) => /not a valid cron line/.test(e)))
  assert.equal(r.spec.enabled, false)
  const none = fromRecipe('just some words', JOB_SCHEMA)
  assert.equal(none.ok, false)
  assert.ok(none.errors[0].includes('--- block'))
})

test('looksLikeRecipe spots a recipe or a job file, not prose', () => {
  assert.equal(looksLikeRecipe(toRecipe(serializeJobFile(spec), JOB_SCHEMA, CTX).text), true)
  assert.equal(looksLikeRecipe(serializeJobFile(spec)), true)
  assert.equal(looksLikeRecipe('Can you sweep my dependency PRs every Monday?'), false)
})

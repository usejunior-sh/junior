// Cuts a release of triage: the scripted version of .claude/skills/release.
//
//   node scripts/release.mjs [patch|minor|major|<x.y.z>] [--notes <file>]
//
// Preflight (on main, clean, not behind origin, package.json = last tag, no
// draft release left over, commits to ship) → typecheck + build + test →
// release notes drafted from the commits and opened in $EDITOR (or taken from
// --notes) → one y/N gate → `npm version` + push with the tag → a *draft*
// GitHub release. The tag push starts .github/workflows/desktop.yml, which
// builds Triage.app for both arches, attaches the zips and install.sh, and
// takes the release out of draft, so `curl | sh` never sees a half-built one.
// Nothing is published to npm.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'

const REPO = 'usetriage/triage'

const argv = process.argv.slice(2)
const option = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)
}
const notesFile = option('--notes')
const bump = argv.find((a) => !a.startsWith('--') && a !== notesFile) ?? 'patch'

// The personal gh account (push on usetriage/triage) lives in its own config
// dir; direnv sets it in this repo, but a shell without direnv would get the
// work account and fail at `gh release create`.
const ghConfig = path.join(os.homedir(), '.config', 'gh-triage')
const env = { ...process.env }
if (!env.GH_CONFIG_DIR && existsSync(ghConfig)) env.GH_CONFIG_DIR = ghConfig

const out = (cmd, ...args) => execFileSync(cmd, args, { encoding: 'utf8', env }).trim()
const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: 'inherit', env })
const git = (...args) => out('git', ...args)
const gh = (...args) => out('gh', ...args)

function die(msg) {
  console.error(`\nrelease stopped: ${msg}`)
  process.exit(1)
}
const ok = (msg) => console.log(`  ✓ ${msg}`)

console.log('\npreflight')
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'main') die('not on main')
ok('on main')
if (git('status', '--porcelain') !== '') die('uncommitted changes — commit or stash them first')
ok('clean tree')
git('fetch', '--quiet', 'origin')
if (git('rev-list', '--count', 'HEAD..origin/main') !== '0') die('behind origin/main — pull first')
ok('not behind origin')

const lastTag = git('describe', '--tags', '--abbrev=0')
const current = JSON.parse(readFileSync('package.json', 'utf8')).version
if (`v${current}` !== lastTag) die(`package.json is ${current} but the last tag is ${lastTag}`)
ok(`at ${lastTag}`)

const commits = git('log', `${lastTag}..HEAD`, '--format=%s', '--no-merges').split('\n').filter(Boolean)
if (commits.length === 0) die(`no commits since ${lastTag} — nothing to release`)
ok(`${commits.length} commits since ${lastTag}`)

try {
  gh('repo', 'view', REPO, '--json', 'nameWithOwner')
} catch {
  die(`gh can't see ${REPO} — check \`gh auth status\` (GH_CONFIG_DIR=${env.GH_CONFIG_DIR ?? 'unset'})`)
}
const drafts = JSON.parse(gh('release', 'list', '--repo', REPO, '--limit', '10', '--json', 'tagName,isDraft'))
  .filter((r) => r.isDraft)
  .map((r) => r.tagName)
if (drafts.length) die(`draft release left over: ${drafts.join(', ')} — re-run its CI or delete it first`)
ok('no draft releases')

const [major, minor, patch] = current.split(/[.-]/).map(Number)
const version =
  bump === 'patch' ? `${major}.${minor}.${patch + 1}`
  : bump === 'minor' ? `${major}.${minor + 1}.0`
  : bump === 'major' ? `${major + 1}.0.0`
  : bump.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) die(`not a version or bump keyword: ${bump}`)
if (git('tag', '--list', `v${version}`)) die(`tag v${version} already exists`)

console.log('\nchecks')
run('npm', 'run', 'typecheck')
run('npm', 'run', 'build')
run('npm', 'test')

let notes
if (notesFile) {
  notes = readFileSync(notesFile, 'utf8')
} else {
  // A starting point, not the notes: commit subjects are rewritten in the
  // editor as user-visible outcomes under Added / Changed / Fixed.
  const draft = path.join(mkdtempSync(path.join(os.tmpdir(), 'triage-release-')), 'NOTES.md')
  const lines = commits.filter((s) => !/^(chore|docs)(\(.*\))?:/.test(s)).map((s) => `- ${s}`)
  writeFileSync(
    draft,
    [
      'Install or update: `curl -fsSL https://usetriage.sh/install.sh | sh`',
      '',
      '### Added',
      '',
      '### Changed',
      '',
      ...lines,
      '',
      '### Fixed',
      '',
      `**Full changelog**: https://github.com/${REPO}/compare/${lastTag}...v${version}`,
      '',
    ].join('\n'),
  )
  const editor = env.VISUAL || env.EDITOR || 'vi'
  console.log(`\nopening the release notes in ${editor} — save and close to continue`)
  execFileSync('sh', ['-c', `${editor} "$1"`, 'sh', draft], { stdio: 'inherit', env })
  notes = readFileSync(draft, 'utf8')
}
// Drop headings left with nothing under them.
notes = notes.replace(/^###[^\n]*\n+(?=###|\*\*Full changelog|(?![\s\S]))/gm, '')
if (!notes.trim()) die('release notes are empty')

console.log(`\n────────────────────────────────────────\nv${current} → v${version}\n\n${notes.trim()}\n`)
console.log('about to run:')
console.log(`  npm version ${version} -m "release: v%s"`)
console.log('  git push --follow-tags origin main')
console.log(`  gh release create v${version} --draft --repo ${REPO}`)
const rl = createInterface({ input: process.stdin, output: process.stdout })
const answer = await rl.question('\nrelease? [y/N] ')
rl.close()
if (!/^y(es)?$/i.test(answer.trim())) die('not confirmed — nothing was changed')

run('npm', 'version', version, '-m', 'release: v%s')
run('git', 'push', '--follow-tags', 'origin', 'main')

const notesOut = path.join(mkdtempSync(path.join(os.tmpdir(), 'triage-release-')), 'NOTES.md')
writeFileSync(notesOut, notes)
run('gh', 'release', 'create', `v${version}`, '--repo', REPO, '--draft', '--title', `v${version}`, '--notes-file', notesOut)

console.log(`
v${version} is tagged and drafted. CI builds Triage.app and publishes it (~15–20 min):

  gh run list --repo ${REPO} --workflow desktop.yml --limit 1
  gh run watch <run-id> --repo ${REPO} --exit-status

then update this Mac:  curl -fsSL https://usetriage.sh/install.sh | sh  &&  triage restart`)

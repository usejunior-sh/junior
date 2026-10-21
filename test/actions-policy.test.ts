/**
 * One policy (core/actions/policy.ts), sorted by the default actions file:
 * a push to a branch that isn't the default one and a draft PR are free;
 * force, the default branch and every other send are held.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortCall } from '../core/actions/sort.js'
import { DEFAULT_RULES } from '../core/actions/rules.js'
import { chatBashVerdict, chatPermissionMode, mayBeFree, type BranchScope } from '../core/actions/policy.js'

const sort = (part: string) => sortCall('Bash', { command: part }, { rules: DEFAULT_RULES })
const onFeat: BranchScope = { current: 'feat/retries', defaultBranch: 'main' }
const v = (cmd: string, s: BranchScope = onFeat) => chatBashVerdict(cmd, s, sort)

test('a push to your own branch is free, a lease included', () => {
  assert.deepEqual(v('git push origin feat/retries'), { verdict: 'allow', free: 'your branch' })
  assert.deepEqual(v('git push -u origin HEAD'), { verdict: 'allow', free: 'your branch' })
  assert.deepEqual(v('git push'), { verdict: 'allow', free: 'your branch' })
  assert.deepEqual(v('git add -A && git commit -m "x" && git push --force-with-lease origin HEAD:feat/retries'), { verdict: 'allow', free: 'your branch' })
})

test('the default branch, force, deletes and wide pushes are held', () => {
  assert.equal(v('git push origin main').verdict, 'hold')
  assert.equal(v('git push origin HEAD:main').verdict, 'hold')
  assert.equal(v('git push', { current: 'main', defaultBranch: 'main' }).verdict, 'hold')
  assert.equal(v('git push --force origin feat/retries').verdict, 'hold')
  assert.equal(v('git push -f').verdict, 'hold')
  assert.equal(v('git push origin +HEAD:feat/retries').verdict, 'hold')
  assert.equal(v('git push origin --delete feat/retries').verdict, 'hold')
  assert.equal(v('git push origin :feat/retries').verdict, 'hold')
  assert.equal(v('git push --all origin').verdict, 'hold')
  assert.equal(v('git push --tags').verdict, 'hold')
})

test('an unknown default branch counts main and master as default', () => {
  const s = { current: 'feat/x', defaultBranch: null }
  assert.equal(v('git push origin master', s).verdict, 'hold')
  assert.equal(v('git push origin main', s).verdict, 'hold')
  assert.equal(v('git push origin feat/x', s).verdict, 'allow')
})

test('an implicit push from another folder is held', () => {
  assert.equal(v('cd ../other && git push').verdict, 'hold')
  assert.equal(v('git -C ../other push').verdict, 'hold')
  assert.equal(v('git push', { current: null, defaultBranch: 'main' }).verdict, 'hold')
  assert.equal(v('cd ../other && git push origin feat/y').verdict, 'allow', 'a named branch says where it goes')
})

test('a draft PR is free; a ready one and every other send is held', () => {
  assert.deepEqual(v('gh pr create --draft --title "Fix" --body "x"'), { verdict: 'allow', free: 'draft PR' })
  assert.deepEqual(v('gh pr create -d -t Fix -b x'), { verdict: 'allow', free: 'draft PR' })
  assert.equal(v('gh pr create --title "Fix" --body "x"').verdict, 'hold')
  assert.equal(v('gh pr comment 12 --body "hi"').verdict, 'hold')
  assert.equal(v('gh pr edit 12 --add-reviewer anirudha').verdict, 'hold')
  assert.equal(v('gh pr ready 12').verdict, 'hold')
  assert.equal(v('gh pr merge 12').verdict, 'hold')
  assert.equal(v('git push origin feat/retries && gh pr comment 12 --body hi').verdict, 'hold', 'one held part holds the command')
})

test('local work sends nothing', () => {
  assert.deepEqual(v('npm test'), { verdict: 'allow', free: null })
  assert.deepEqual(v('git commit -am "x"'), { verdict: 'allow', free: null })
  assert.deepEqual(v('git push --dry-run origin main'), { verdict: 'allow', free: null })
})

test('mayBeFree spots the commands that need a branch lookup', () => {
  assert.ok(mayBeFree('git push'))
  assert.ok(mayBeFree('git -C x push origin y'))
  assert.ok(mayBeFree('gh pr create --draft'))
  assert.ok(!mayBeFree('gh pr comment 1'))
})

test('chats: Claude holds sends, another agent asks before every change', () => {
  assert.equal(chatPermissionMode('claude'), 'auto')
  assert.equal(chatPermissionMode(undefined), 'auto')
  assert.equal(chatPermissionMode('codex'), 'gated')
})

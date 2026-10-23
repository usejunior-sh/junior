/**
 * The bypass corpus: every shape of push the engineering audit's probe ran
 * free (Oct 24 2026), and the near misses that must stay free, against the one
 * policy (core/actions/policy.ts) and the default actions file. One row per
 * shape, both directions. A fixed hole stays fixed: add a row, never drop one.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sortCall } from '../core/actions/sort.js'
import { DEFAULT_RULES } from '../core/actions/rules.js'
import { chatBashVerdict, type BranchScope } from '../core/actions/policy.js'
import { pushRefs, pushTarget, splitCommand } from '../core/actions/bash.js'

const sort = (part: string) => sortCall('Bash', { command: part }, { rules: DEFAULT_RULES })
const onMain: BranchScope = { current: 'main', defaultBranch: 'main' }
const onFeat: BranchScope = { current: 'feat/x', defaultBranch: 'main' }
const verdict = (cmd: string, s: BranchScope) => chatBashVerdict(cmd, s, sort).verdict

type Row = [command: string, scope: BranchScope, expected: 'hold' | 'allow', why: string]

const ROWS: Row[] = [
  // The audit's probe: each ran free on main.
  ['git push -u origin "$(git branch --show-current)"', onMain, 'hold', 'the current-branch substitution is main'],
  ['git push origin @', onMain, 'hold', '@ is the checked-out branch'],
  ['B=main; git push origin $B', onMain, 'hold', 'a variable target is unknown'],
  ['git push origin "${BRANCH}"', onMain, 'hold', 'a braced variable target is unknown'],
  ['eval "git push origin main"', onMain, 'hold', 'eval runs its words as a script'],
  ['echo main | xargs git push origin', onMain, 'hold', 'xargs feeds the refspec in'],
  ['git push origin HEAD', onMain, 'hold', 'HEAD is main, as before'],
  // Unknown targets hold on any branch: the shell decides them, not us.
  ['B=main; git push origin $B', onFeat, 'hold', 'a variable could still be main'],
  ['git push origin "${BRANCH}"', onFeat, 'hold', 'unknown even on a feature branch'],
  ['echo main | xargs git push origin', onFeat, 'hold', 'xargs on a feature branch still pushes main'],
  ['xargs -I {} git push origin {} < branches.txt', onFeat, 'hold', 'xargs with a placeholder'],
  ['git push origin `echo main`', onFeat, 'hold', 'a backtick target is unknown'],
  ['git push origin "$(echo main)"', onFeat, 'hold', 'any other substitution is unknown'],
  ['git push origin HEAD:$B', onFeat, 'hold', 'an unknown destination'],
  ['git push origin $(echo main feat/x)', onFeat, 'hold', 'an unquoted substitution could split into refspecs'],
  ['git push $REMOTE', onFeat, 'hold', 'an unquoted remote could split into a remote and a refspec'],
  ['git push $FLAGS origin feat/x', onFeat, 'hold', 'flags only the shell knows'],
  ['git push -$F origin feat/x', onFeat, 'hold', 'a flag that could be -f'],
  ['git $OPTS push origin feat/x', onFeat, 'hold', 'git options only the shell knows'],
  ["git push origin 'refs/heads/*'", onFeat, 'hold', 'a glob refspec'],
  ['git push origin {main,feat/x}', onFeat, 'hold', 'brace expansion pushes both'],
  ['git push origin @{upstream}', onFeat, 'hold', 'an @{…} ref is not a branch name'],
  ['git push origin feat/x main', onFeat, 'hold', 'a second refspec to main'],
  ['git push origin feat/x >log main', onFeat, 'hold', 'a refspec after a redirection still counts'],
  ['git push origin <(echo main)', onFeat, 'hold', 'a process substitution target'],
  ['eval git push origin main', onFeat, 'hold', 'eval without quotes'],
  ["bash -c 'eval \"git push origin main\"'", onFeat, 'hold', 'eval inside bash -c'],
  ['env bash -c "git push origin main"', onFeat, 'hold', 'a shell behind a wrapper is opened too'],
  ["echo x | xargs sh -c 'git push origin main'", onFeat, 'hold', 'a shell behind xargs is opened too'],
  ['sudo -u me git push origin main', onFeat, 'hold', 'a wrapper flag value is not the command'],
  ['GIT_DIR=../other/.git git push', onFeat, 'hold', 'an implicit push into another repo'],
  ['env -C ../other git push', onFeat, 'hold', 'env -C moves git to another folder'],
  ['git -C ../other push origin "$(git branch --show-current)"', onFeat, 'hold', 'the current branch of another folder'],
  ['cd ../other && git push origin @', onFeat, 'hold', 'after a cd, @ is another folder’s branch'],
  ['eval "git push origin feat/x && gh pr comment 1 --body hi"', onFeat, 'hold', 'one held part inside eval holds it'],
  // Near misses that stay free on your own branch.
  ['git push -u origin "$(git branch --show-current)"', onFeat, 'allow', 'the current-branch substitution is feat/x'],
  ['git push -u origin "$(git rev-parse --abbrev-ref HEAD)"', onFeat, 'allow', 'the rev-parse form of it'],
  ['git push origin HEAD:"$(git branch --show-current)"', onFeat, 'allow', 'HEAD to the current branch by name'],
  ['git push origin @', onFeat, 'allow', '@ is feat/x'],
  ['git push origin feat/x', onFeat, 'allow', 'a branch by name'],
  ['git push origin HEAD', onFeat, 'allow', 'HEAD is feat/x, as before'],
  ['git push -u origin HEAD 2>&1 | tail -5', onFeat, 'allow', 'redirections are not refspecs'],
  ['git push origin feat/x > /tmp/push.log', onFeat, 'allow', 'a redirection target is not a refspec'],
  ['git push --force-with-lease origin HEAD:feat/x', onFeat, 'allow', 'a lease on your branch'],
  ['git push', onFeat, 'allow', 'implicit, your branch'],
  ['git push -o ci.skip origin feat/x', onFeat, 'allow', 'a push option and its value'],
  ['eval "git push origin feat/x"', onFeat, 'allow', 'eval is judged by what it runs'],
  ['bash -c "git push origin feat/x"', onFeat, 'allow', 'so is bash -c, as before'],
]

for (const [cmd, scope, expected, why] of ROWS) {
  test(`bypass corpus: ${expected} on ${scope.current}: ${cmd}`, () => {
    assert.equal(verdict(cmd, scope), expected, why)
  })
}

test('pushRefs: what each refspec sends to', () => {
  const r = (c: string) => pushRefs(splitCommand(c)[0])
  assert.deepEqual(r('git push'), ['current'])
  assert.deepEqual(r('git push origin'), ['current'])
  assert.deepEqual(r('git push origin @'), ['current'])
  assert.deepEqual(r('git push origin "$(git branch --show-current)"'), ['current'])
  assert.deepEqual(r('git push origin `git branch --show-current`'), ['current'])
  assert.deepEqual(r('git push origin HEAD:feat'), [{ branch: 'feat' }])
  assert.deepEqual(r('git push origin feat main'), [{ branch: 'feat' }, { branch: 'main' }])
  assert.deepEqual(r('git push origin $B'), ['unknown'])
  assert.deepEqual(r('git push origin "$(git branch --show-current) extra"'), ['unknown'])
  assert.deepEqual(r('git push -- origin feat'), [{ branch: 'feat' }])
  assert.deepEqual(r('npm test'), [])
})

test('pushTarget names a branch only when exactly one is named', () => {
  const t = (c: string) => pushTarget(splitCommand(c)[0])
  assert.equal(t('git push origin feat'), 'feat')
  assert.equal(t('git push origin $B'), null)
  assert.equal(t('git push origin @'), null)
  assert.equal(t('git push origin feat main'), null)
  assert.equal(t('echo feat | xargs git push origin'), null)
})

test('eval and xargs are opened by the splitter: what they run sorts as an action', () => {
  assert.equal(sort('eval "gh pr comment 12 --body hi"')?.kind, 'comment')
  assert.equal(sort('echo 12 | xargs gh pr merge')?.kind, 'merge')
  assert.equal(sort('echo hi | xargs -n 1 echo'), null)
  assert.ok(splitCommand('eval "git push origin main"').some((p) => p.join(' ') === 'git push origin main'))
})

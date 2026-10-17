/**
 * The two shell checks behind the Autonomy levels: what runs alone at
 * "Asks before commands", and what still asks at "Asks before sending".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { destructiveCommand, readOnlyCommand } from '../core/actions/commands.js'

test('read-only commands run alone', () => {
  for (const cmd of [
    'git status',
    'git log --oneline -20',
    'git diff HEAD~1',
    'gh pr view 12',
    'ls -la web/src',
    'cat package.json',
    'head -40 server/index.ts',
    'grep -rn "autonomy" web/src',
    'rg permissionMode',
    'find . -name "*.ts"',
    'pwd',
  ]) assert.equal(readOnlyCommand(cmd), true, cmd)
})

test('anything else, or anything attached, asks', () => {
  for (const cmd of [
    'npm install',
    'npm test',
    'git commit -m x',
    'git push',
    'gh pr comment 12 -b hi',
    'ls; rm -rf x',
    'ls && rm -rf x',
    'cat a > b',
    'grep x $(rm -rf y)',
    'ls `rm -rf y`',
    'cat a\nrm -rf b',
    'find . -name x -delete',
    'find . -exec rm {} +',
    'lsof -i :5188',
    'catalog',
  ]) assert.equal(readOnlyCommand(cmd), false, cmd)
})

test('destructive commands are caught, chained or not', () => {
  for (const cmd of [
    'rm -rf dist',
    'rm -r tmp',
    'rm -fR build',
    'rm --recursive x',
    'npm run build && rm -rf node_modules',
    'sudo rm -rf /tmp/x',
    'git reset --hard HEAD~2',
    'git clean -fd',
    'git checkout -- .',
    'git restore .',
    'git branch -D feat/x',
    'git stash drop',
    'git stash clear',
    'dropdb triage',
    'psql -c "DROP TABLE users"',
    'sqlite3 x.db "truncate table t"',
    'bash -c "git reset --hard"',
    'echo $(rm -rf x)',
  ]) assert.ok(destructiveCommand(cmd), cmd)
})

test('ordinary work is not destructive', () => {
  for (const cmd of [
    'rm notes.txt',
    'npm test',
    'git reset HEAD file.ts',
    'git checkout main',
    'git branch -d merged',
    'git stash',
    'git stash pop',
    'git clean -n',
    'echo "drop it"',
    'git push origin main',
  ]) assert.equal(destructiveCommand(cmd), null, cmd)
})

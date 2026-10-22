/**
 * Dev data root (scripts/dev-home.mjs): `npm run dev` / `dev:server` keep their
 * data in ~/.junior-dev unless JUNIOR_HOME is already set. Resolved in a child
 * process that only imports server/state.ts — no server, no ports.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { applyDevHome, DEV_HOME } from '../scripts/dev-home.mjs'

const probe = `import('./server/state.ts').then((m) => console.log(m.JUNIOR_DIR))`

/** JUNIOR_DIR as `dev:server` would resolve it: preload dev-home, then load state.ts. */
function resolveDir(juniorHome?: string): string {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.JUNIOR_HOME
  if (juniorHome) env.JUNIOR_HOME = juniorHome
  const r = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--import', './scripts/dev-home.mjs', '-e', probe],
    { env, cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' },
  )
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}

test('dev data root defaults to ~/.junior-dev', () => {
  assert.equal(DEV_HOME, path.join(os.homedir(), '.junior-dev'))
  assert.equal(resolveDir(), DEV_HOME)
  assert.equal(applyDevHome({}), DEV_HOME)
})

test('an explicit JUNIOR_HOME is used unchanged', () => {
  const prod = path.join(os.homedir(), '.junior')
  assert.equal(resolveDir(prod), prod)
  assert.equal(applyDevHome({ JUNIOR_HOME: '/tmp/x' }), '/tmp/x')
})

test('prod default stays ~/.junior', () => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env.JUNIOR_HOME
  const r = spawnSync(process.execPath, ['--import', 'tsx', '-e', probe], {
    env,
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf8',
  })
  assert.equal(r.stdout.trim(), path.join(os.homedir(), '.junior'))
})

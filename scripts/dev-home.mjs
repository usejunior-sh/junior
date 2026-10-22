// Dev keeps its data apart from prod's ~/.junior: migrations, job schedulers,
// server.json, phone pairing and logs all live under JUNIOR_HOME. An explicit
// JUNIOR_HOME (e.g. `JUNIOR_HOME=~/.junior npm run dev`) wins unchanged.
//
// Imported by scripts/dev.mjs, and preloaded (`tsx --import`) by `dev:server`
// so the value is set before server/state.ts reads it.
import os from 'node:os'
import path from 'node:path'

export const DEV_HOME = path.join(os.homedir(), '.junior-dev')

export function applyDevHome(env = process.env) {
  env.JUNIOR_HOME ||= DEV_HOME
  return env.JUNIOR_HOME
}

applyDevHome()

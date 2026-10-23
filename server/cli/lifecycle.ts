import { readFile } from 'node:fs/promises'
import { readState, DEFAULT_PORT, type Health, LOG_FILE, checkHealth, JUNIOR_DIR } from '../state.js'
import { launchAgentInstalled, unloadLaunchAgent } from '../launchd.js'
import { explicitPort } from './args.js'
import { bold, box, cyan, die, dim, green, row, tilde, yellow } from './ui.js'

/**
 * Which port to talk to. A fresh start uses the default unless overridden;
 * stop/status/restart/logs prefer the port the last server recorded, so they
 * find a --port server without the flag being repeated.
 */
export async function resolvePort(forStart: boolean): Promise<number> {
  if (explicitPort !== null) return explicitPort
  if (process.env.PORT) return Number(process.env.PORT)
  if (!forStart) {
    const state = await readState()
    if (state?.port) return state.port
  }
  return DEFAULT_PORT
}

// commands

/** The build, coloured by how far it is from what everyone else has. */
function buildLine(b: NonNullable<Health['build']>): string {
  if (b.channel === 'dev') return yellow(`working tree ${dim(`(${b.home})`)}`)
  if (b.channel === 'release') return green('released')
  const from = [b.commit && `from ${b.commit}`, b.dirty && 'uncommitted changes'].filter(Boolean).join(', ')
  return yellow(`unreleased${from ? ` ${dim(`(${from})`)}` : ''}`)
}

export function printRunning(health: Health, verb: string, showDb = false) {
  const lines = [
    `${green('●')} ${bold(`junior ${verb}`)}`,
    '',
    `${dim('→')} ${bold(cyan(`http://junior.localhost:${health.port}`))}`,
    `${dim('  also http://localhost:' + health.port)}`,
    '',
    row('version', health.version),
    // Which copy answered. Several can be installed at once, so a bare version
    // is not an answer: name the channel, and the path when it isn't a release.
    ...(health.build ? [row('build', buildLine(health.build)), row('from', tilde(health.build.root))] : []),
    row('pid', String(health.pid)),
  ]
  if (health.liveSessions > 0) {
    lines.push(row('sessions', yellow(`${health.liveSessions} live`)))
  }
  if (health.unhealthy) {
    lines.push(row('health', yellow(`exits once the current turns end: ${health.unhealthy.reason}`)))
  }
  lines.push(row('logs', tilde(LOG_FILE)))
  if (showDb) lines.push(row('db', tilde(health.db)))
  lines.push('', `${cyan('junior restart')} ${dim('·')} ${cyan('junior stop')} ${dim('·')} ${cyan('junior logs')}`)
  box(lines)
}

export async function logTail(lines: number): Promise<string> {
  try {
    const log = await readFile(LOG_FILE, 'utf8')
    return log.trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

export async function stop(port: number): Promise<boolean> {
  const health = await checkHealth(port)
  if (health === 'other') {
    die(`port ${port} is in use by something that isn't Junior — nothing to stop`)
  }
  if (!health) {
    const state = await readState()
    if (state && state.port === port && isAlive(state.pid)) {
      die(
        `process ${state.pid} from ${JUNIOR_DIR}/server.json is alive but not answering ` +
          `/api/health — not touching it; if it's a hung Junior, run ${cyan(`kill ${state.pid}`)}`,
      )
    }
    console.log(`${dim('○')} Junior is not running`)
    return false
  }

  if (health.liveSessions > 0) {
    console.log(
      `${yellow('!')} stopping ends ${bold(String(health.liveSessions))} live Claude session${health.liveSessions === 1 ? '' : 's'}`,
    )
  }
  // KeepAlive would restart a killed server: unload the agent first. It loads
  // again on `junior start` or at the next login.
  if (launchAgentInstalled()) await unloadLaunchAgent()
  process.kill(health.pid, 'SIGTERM')
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
    if (!isAlive(health.pid)) {
      console.log(`${green('✓')} Junior stopped ${dim(`(pid ${health.pid})`)}`)
      return true
    }
  }
  process.kill(health.pid, 'SIGKILL')
  console.log(`${yellow('!')} Junior did not exit within 10s — killed ${dim(`(pid ${health.pid})`)}`)
  return true
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function status(port: number) {
  const health = await checkHealth(port)
  if (health === 'other') {
    console.log(`${dim('○')} Junior is not running ${dim(`(port ${port} is in use by something else)`)}`)
    process.exitCode = 1
    return
  }
  if (!health) {
    console.log(`${dim('○')} junior is not running — start it with ${cyan('junior')}`)
    process.exitCode = 1
    return
  }
  printRunning(health, 'is running', true)
}

export async function logs() {
  const tail = await logTail(50)
  if (!tail) {
    console.log(
      `${dim('○')} no log file yet at ${tilde(LOG_FILE)} — the server hasn't been started in the background`,
    )
    return
  }
  console.log(tail)
  console.log(dim(`\n(full log: ${tilde(LOG_FILE)})`))
}

/**
 * The daemon's supervisor: one stray promise can't take every session down.
 *
 * Node 22 exits on an unhandled rejection, and every live Claude subprocess
 * dies with it. Here a rejection is logged and the daemon keeps going. An
 * uncaught exception leaves the process in a state nobody planned for, so it
 * still ends the daemon (launchd starts a fresh one), but never under a turn:
 * while any session is mid-turn the daemon is marked unhealthy and waits for
 * the turns to end first.
 *
 * Background work that nobody awaits goes through fireAndLog, which logs its
 * failure with the area and workspace it belongs to instead of letting it
 * reach the process handlers at all.
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from './log.js'
import { errText } from './errors.js'

/** The part of a WorkspaceRuntime fireAndLog needs: kept structural so tests need no runtime. */
export interface Supervised {
  meta: { id: string }
}

/**
 * Run background work nobody awaits. A rejection (or a throw from a thunk) is
 * logged under `area`, with the workspace, and never reaches the caller or the
 * process. Returns nothing on purpose: there is nothing to await.
 */
export function fireAndLog(rt: Supervised | null, area: string, work: Promise<unknown> | (() => Promise<unknown> | unknown)): void {
  const fields = rt ? { workspace: rt.meta.id } : undefined
  const fail = (err: unknown) => {
    log('error', area, `background work failed: ${errText(err)}`, { ...fields, ...stackField(err) })
  }
  let p: Promise<unknown> | unknown
  try {
    p = typeof work === 'function' ? work() : work
  } catch (err) {
    fail(err)
    return
  }
  if (p && typeof (p as Promise<unknown>).then === 'function') (p as Promise<unknown>).then(undefined, fail)
}

export type Fault = 'rejection' | 'exception'
export type Verdict = 'keep-running' | 'exit' | 'wait-for-turns'

/**
 * What the daemon does about a fault nobody handled. A rejection: log and
 * keep running. An exception: exit, unless a session is mid-turn, then mark
 * the daemon unhealthy and exit once the turns end.
 */
export function decide(fault: Fault, midTurn: number): Verdict {
  if (fault === 'rejection') return 'keep-running'
  return midTurn > 0 ? 'wait-for-turns' : 'exit'
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where a fault came from: the first stack frame in our own code, as
 * "server/tasks/runner.ts:393", and its area (the folder under server/ or
 * core/, else the file's name). Node internals and node_modules are skipped.
 */
export function originOf(stack: string | undefined, root = ROOT): { where: string; area: string } | null {
  if (!stack) return null
  for (const line of stack.split('\n').slice(1)) {
    const m = /\(?((?:file:\/\/)?\/[^():]+):(\d+):\d+\)?\s*$/.exec(line.trim())
    if (!m) continue
    const file = m[1]!.replace(/^file:\/\//, '')
    if (file.includes('/node_modules/') || !file.startsWith(root + '/')) continue
    const rel = path.relative(root, file).replace(/^dist\//, '').replace(/\.js$/, '.ts')
    const parts = rel.split('/')
    const area = parts.length > 2 && (parts[0] === 'server' || parts[0] === 'core') ? parts[1]! : path.basename(rel, '.ts')
    return { where: `${rel}:${m[2]}`, area }
  }
  return null
}

function stackField(err: unknown): { stack?: string } {
  const stack = err instanceof Error ? err.stack : undefined
  return stack ? { stack: stack.split('\n').slice(0, 8).join('\n') } : {}
}

export interface Unhealthy {
  since: number
  reason: string
}

export interface SupervisorDeps {
  /** How many sessions, across workspaces, are mid-turn right now. */
  midTurn: () => number
  /** End the daemon: clean up, then process.exit(code). */
  exit: (code: number) => void
  /** How often an unhealthy daemon checks whether the turns ended. */
  pollMs?: number
  now?: () => number
}

export interface Supervisor {
  onRejection: (reason: unknown) => void
  onException: (err: unknown) => void
  /** Set after an uncaught exception that arrived mid-turn. */
  health: () => Unhealthy | null
}

/** The process handlers, apart from the process: installSupervisor registers them, tests call them. */
export function createSupervisor(deps: SupervisorDeps): Supervisor {
  const poll = deps.pollMs ?? 15_000
  const now = deps.now ?? Date.now
  let unhealthy: Unhealthy | null = null
  let exited = false
  const exit = () => {
    if (exited) return
    exited = true
    deps.exit(1)
  }

  return {
    health: () => unhealthy,
    onRejection(reason) {
      const from = originOf(reason instanceof Error ? reason.stack : undefined)
      log('error', from?.area ?? 'supervisor', `unhandled rejection, kept running: ${errText(reason)}`, {
        ...(from ? { where: from.where } : {}),
        ...stackField(reason),
      })
    },
    onException(err) {
      const from = originOf(err instanceof Error ? err.stack : undefined)
      const area = from?.area ?? 'supervisor'
      const fields = { ...(from ? { where: from.where } : {}), ...stackField(err) }
      const midTurn = safeCount(deps.midTurn)
      if (decide('exception', midTurn) === 'exit') {
        log('error', area, `uncaught exception, exiting: ${errText(err)}`, fields)
        exit()
        return
      }
      if (unhealthy) {
        log('error', area, `another uncaught exception while unhealthy: ${errText(err)}`, fields)
        return
      }
      unhealthy = { since: now(), reason: errText(err) }
      log('error', area, `uncaught exception with ${midTurn} session(s) mid-turn: unhealthy, exiting once they end: ${errText(err)}`, fields)
      const timer = setInterval(() => {
        if (safeCount(deps.midTurn) > 0) return
        clearInterval(timer)
        log('error', 'supervisor', 'the turns ended: exiting after the earlier uncaught exception')
        exit()
      }, poll)
      // The server keeps the daemon alive; this timer alone shouldn't.
      timer.unref()
    },
  }
}

let current: Supervisor | null = null

/** Set after an uncaught exception that arrived mid-turn: the daemon exits once the turns end. */
export function supervisorHealth(): Unhealthy | null {
  return current?.health() ?? null
}

/** Register the process handlers. Once per process; later calls do nothing. */
export function installSupervisor(deps: SupervisorDeps): void {
  if (current) return
  current = createSupervisor(deps)
  process.on('unhandledRejection', current.onRejection)
  process.on('uncaughtException', current.onException)
}

/** A count that can't throw inside a handler: unknown counts as one turn, so nothing is cut off. */
function safeCount(fn: () => number): number {
  try {
    return fn()
  } catch {
    return 1
  }
}

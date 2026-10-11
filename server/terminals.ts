/**
 * PTY-backed terminals for the web UI.
 *
 * One manager per workspace: every terminal is a real shell (node-pty) running
 * with the workspace's spawn env, so `claude` inside it uses that workspace's
 * auth backend, the same way a dispatched session does. Output is fanned out
 * to every WS client of the workspace and kept in a bounded scrollback buffer
 * so a tab opened later — or a reconnecting socket — sees what happened.
 *
 * Terminals are deliberately ephemeral: a daemon restart kills the processes,
 * so there is nothing truthful to persist.
 */
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import * as pty from 'node-pty'
import type { ServerMessage, TerminalSummary } from '../shared/protocol.js'

/** Scrollback kept per terminal, in bytes of UTF-16 text (~256 KB). */
const SCROLLBACK_LIMIT = 256 * 1024
/** Output is coalesced for this long before it goes on the wire. */
const FLUSH_MS = 8

type Term = {
  summary: TerminalSummary
  proc: pty.IPty | null
  chunks: string[]
  buffered: number
  pending: string
  flush: ReturnType<typeof setTimeout> | null
}

export type CreateTerminalOptions = {
  cwd?: string
  /** the project the shell belongs to; null only when the workspace has none */
  projectId?: string | null
  title?: string
  /** typed into the shell once it is up, followed by Enter */
  command?: string
  env?: Record<string, string>
}

function defaultShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

/** Login shell for the usual Unix shells, so PATH and friends come from the profile. */
function shellArgs(shell: string): string[] {
  const name = path.basename(shell)
  return ['zsh', 'bash', 'fish', 'sh'].includes(name) ? ['-l'] : []
}

export class TerminalManager {
  readonly #terms = new Map<string, Term>()

  constructor(
    private readonly broadcast: (msg: ServerMessage) => void,
    private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void,
  ) {}

  list(): TerminalSummary[] {
    return [...this.#terms.values()].map((t) => t.summary).sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): TerminalSummary | undefined {
    return this.#terms.get(id)?.summary
  }

  /** The recorded output so far, for a subscriber that arrived late. */
  history(id: string): string {
    const t = this.#terms.get(id)
    return t ? t.chunks.join('') + t.pending : ''
  }

  create(opts: CreateTerminalOptions): TerminalSummary {
    const shell = defaultShell()
    const cwd = opts.cwd && opts.cwd.trim() ? opts.cwd : os.homedir()
    const id = randomUUID()
    // A daemon started via `npm run` carries npm's own variables; a shell that
    // inherits them misbehaves (nvm complains about npm_config_prefix, npm
    // scripts see a phantom lifecycle). Drop them — they describe the daemon's
    // launch, not the user's shell.
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(opts.env ?? (process.env as Record<string, string>))) {
      if (v === undefined) continue
      if (k.startsWith('npm_') || k === 'INIT_CWD' || k === 'NODE_OPTIONS') continue
      env[k] = v
    }
    Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', TRIAGE_TERMINAL: id })
    const proc = pty.spawn(shell, shellArgs(shell), {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env,
    })
    const summary: TerminalSummary = {
      id,
      title: opts.title?.trim() || `${path.basename(cwd) || cwd} · ${path.basename(shell)}`,
      cwd,
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      shell: path.basename(shell),
      pid: proc.pid,
      status: 'running',
      createdAt: Date.now(),
    }
    const term: Term = { summary, proc, chunks: [], buffered: 0, pending: '', flush: null }
    this.#terms.set(id, term)

    proc.onData((data) => this.#push(term, data))
    proc.onExit(({ exitCode }) => {
      term.proc = null
      term.summary = { ...term.summary, status: 'exited', exitCode }
      this.#flushNow(term)
      this.broadcast({ type: 'terminal_exit', terminalId: id, exitCode })
      this.broadcast({ type: 'terminals', terminals: this.list() })
      this.log('info', `terminal ${id.slice(0, 8)} exited (${exitCode})`)
    })

    if (opts.command?.trim()) {
      // Give the shell a beat to print its prompt so the command lands after it.
      setTimeout(() => term.proc?.write(opts.command!.trim() + '\r'), 150)
    }

    this.log('info', `terminal ${id.slice(0, 8)} opened: ${summary.title} (pid ${proc.pid})`)
    this.broadcast({ type: 'terminals', terminals: this.list() })
    return summary
  }

  write(id: string, data: string): void {
    this.#terms.get(id)?.proc?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.#terms.get(id)
    if (!t?.proc) return
    const c = Math.max(2, Math.min(500, Math.floor(cols)))
    const r = Math.max(1, Math.min(300, Math.floor(rows)))
    try {
      t.proc.resize(c, r)
    } catch {
      // a race with exit — nothing to resize
    }
  }

  rename(id: string, title: string): void {
    const t = this.#terms.get(id)
    if (!t) return
    const next = title.trim()
    if (!next) return
    t.summary = { ...t.summary, title: next }
    this.broadcast({ type: 'terminals', terminals: this.list() })
  }

  /** Kill (if running) and forget. */
  close(id: string): void {
    const t = this.#terms.get(id)
    if (!t) return
    if (t.flush) clearTimeout(t.flush)
    try {
      t.proc?.kill()
    } catch {
      // already gone
    }
    this.#terms.delete(id)
    this.broadcast({ type: 'terminal_closed', terminalId: id })
    this.broadcast({ type: 'terminals', terminals: this.list() })
  }

  /** Daemon shutdown: take the shells down with it. */
  killAll(): void {
    for (const t of this.#terms.values()) {
      try {
        t.proc?.kill()
      } catch {
        // already gone
      }
    }
    this.#terms.clear()
  }

  #push(term: Term, data: string) {
    term.pending += data
    if (!term.flush) term.flush = setTimeout(() => this.#flushNow(term), FLUSH_MS)
  }

  #flushNow(term: Term) {
    if (term.flush) {
      clearTimeout(term.flush)
      term.flush = null
    }
    if (!term.pending) return
    const data = term.pending
    term.pending = ''
    term.chunks.push(data)
    term.buffered += data.length
    while (term.buffered > SCROLLBACK_LIMIT && term.chunks.length > 1) {
      term.buffered -= term.chunks.shift()!.length
    }
    this.broadcast({ type: 'terminal_output', terminalId: term.summary.id, data })
  }
}

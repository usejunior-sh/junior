/**
 * Structured logger with an in-memory ring buffer AND durable JSONL files, so
 * the daemon's activity is (a) inspectable live in the System modal, (b) still
 * there after a restart, and (c) machine-parseable with `jq`/grep.
 *
 * Records are structured (level, subsystem, message, optional `fields` bag) and
 * written one JSON object per line to ~/.junior/logs/junior-YYYY-MM-DD.jsonl.
 * The UI renders them human-readably; the file is the source of truth. On boot
 * we load recent lines back into the ring buffer so the panel is never empty.
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import type { LogEntry, LogLevel } from '../shared/protocol.js'

const MAX_BUFFER = 2000
const RETENTION_DAYS = 7
const buffer: LogEntry[] = []
let seq = 0

let logDir: string | null = null

const dayFile = (d = new Date()) => path.join(logDir!, `junior-${d.toISOString().slice(0, 10)}.jsonl`)

/** Point the logger at a directory and replay recent history into the buffer. */
export function initLogFile(dir: string): void {
  logDir = dir
  try {
    mkdirSync(dir, { recursive: true })
    loadRecent()
    pruneOld()
  } catch (err) {
    console.error('[log] could not init log dir:', err)
    logDir = null
  }
}

export function logFilePath(): string | null {
  return logDir
}

function loadRecent(): void {
  // Replay today's and yesterday's files (newest last), capped to the buffer.
  const files = [dayFile(new Date(Date.now() - 86_400_000)), dayFile()]
  for (const f of files) {
    let text: string
    try {
      text = readFileSync(f, 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as LogEntry
        buffer.push(e)
        if (typeof e.seq === 'number' && e.seq > seq) seq = e.seq
      } catch {
        // skip a corrupt line
      }
    }
  }
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
}

function pruneOld(): void {
  if (!logDir) return
  const cutoff = Date.now() - RETENTION_DAYS * 86_400_000
  for (const name of readdirSync(logDir)) {
    const m = /^junior-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
    if (m && Date.parse(m[1]) < cutoff) {
      try {
        unlinkSync(path.join(logDir, name))
      } catch {
        // best effort
      }
    }
  }
}

export function log(level: LogLevel, subsystem: string, message: string, fields?: Record<string, unknown>): void {
  seq += 1
  const entry: LogEntry = { seq, ts: Date.now(), level, subsystem, message, ...(fields ? { fields } : {}) }
  buffer.push(entry)
  if (buffer.length > MAX_BUFFER) buffer.shift()

  const line = `[${subsystem}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  if (logDir) {
    try {
      appendFileSync(dayFile(), JSON.stringify(entry) + '\n')
    } catch {
      // never let logging crash the caller
    }
  }
}

export interface LogFilter {
  level?: LogLevel
  subsystem?: string
  q?: string
  limit?: number
}

/** Recent log lines, newest last, filtered. */
export function recentLogs(filter: LogFilter = {}): LogEntry[] {
  let out = buffer
  if (filter.level) out = out.filter((e) => e.level === filter.level)
  if (filter.subsystem) out = out.filter((e) => e.subsystem === filter.subsystem)
  if (filter.q) {
    const q = filter.q.toLowerCase()
    out = out.filter(
      (e) =>
        e.message.toLowerCase().includes(q) ||
        e.subsystem.toLowerCase().includes(q) ||
        (e.fields ? JSON.stringify(e.fields).toLowerCase().includes(q) : false),
    )
  }
  return out.slice(-(filter.limit ?? 500))
}

/** The distinct subsystems seen so far (for the filter dropdown). */
export function logSubsystems(): string[] {
  return [...new Set(buffer.map((e) => e.subsystem))].sort()
}

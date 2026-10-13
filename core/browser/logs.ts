/**
 * What the page said, per session: console messages, uncaught errors, failed
 * requests. Bounded, and read "since the last action" by default, so the agent
 * sees what *its* click caused rather than the whole history every time.
 */
import type { PageLog } from './wire.js'

const MAX = 300

export class PageLogBuffer {
  private logs: (PageLog & { seq: number })[] = []
  private seq = 0
  /** the seq the last action / navigation started at */
  private mark = 0
  private loadMark = 0

  push(log: PageLog) {
    this.seq += 1
    this.logs.push({ ...log, seq: this.seq })
    if (this.logs.length > MAX) this.logs.splice(0, this.logs.length - MAX)
  }

  /** an action is about to run: what comes after it is "since the last action" */
  markAction() {
    this.mark = this.seq
  }

  /** a page load is about to run */
  markLoad() {
    this.mark = this.seq
    this.loadMark = this.seq
  }

  since(which: 'action' | 'load' | 'all', level: 'error' | 'warning' | 'all' = 'warning'): (PageLog & { count: number })[] {
    const from = which === 'action' ? this.mark : which === 'load' ? this.loadMark : 0
    const keep = (l: PageLog) => level === 'all' || l.level === 'error' || (level === 'warning' && l.level === 'warning')
    return dedupe(this.logs.filter((l) => l.seq > from && keep(l)))
  }

  /** how many errors since the last load — the one number browser_open reports */
  errorsSinceLoad(): number {
    return this.logs.filter((l) => l.seq > this.loadMark && l.level === 'error').length
  }
}

/** Identical lines folded into one with a count, first-seen order kept. */
export function dedupe(logs: PageLog[]): (PageLog & { count: number })[] {
  const out = new Map<string, PageLog & { count: number }>()
  for (const l of logs) {
    const k = `${l.level}\u0000${l.source}\u0000${l.text}\u0000${l.url ?? ''}`
    const seen = out.get(k)
    if (seen) seen.count += 1
    else out.set(k, { ...l, count: 1 })
  }
  return [...out.values()]
}

export function formatLogs(logs: (PageLog & { count: number })[]): string {
  if (!logs.length) return 'No console errors, warnings or failed requests.'
  return logs
    .map((l) => {
      const n = l.count > 1 ? ` (×${l.count})` : ''
      const where = l.url ? ` — ${l.url}` : ''
      return `[${l.level}] ${l.source}: ${l.text.slice(0, 500)}${where}${n}`
    })
    .join('\n')
}

/**
 * Junior's log on the client (core/junior/log.ts): the Log tab's pages and
 * the rail's unread dot. Refetched when something it reads moves: an action,
 * a task (the inbox frame), an approval, and once a minute for job runs.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LogFilter, LogLine } from '../../core/junior/log.js'
import { store } from './store.js'

type JuniorLog = { lines: LogLine[]; more: boolean; latestAt: number; seenAt: number }
type LogResponse = { ok: true; log: JuniorLog } | { ok: false; error: string }

async function fetchLog(filter: LogFilter, before: number | null, limit: number): Promise<JuniorLog | null> {
  try {
    const q = new URLSearchParams({ filter, limit: String(limit), ...(before ? { before: String(before) } : {}) })
    const body = (await (await fetch(`/api/junior/log?${q}`)).json()) as LogResponse
    return body.ok ? body.log : null
  } catch {
    return null
  }
}

/** Fire `fn` (debounced) whenever the log may have moved. */
function onLogMoved(fn: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const kick = () => {
    clearTimeout(timer)
    timer = setTimeout(fn, 250)
  }
  const offs = [store.onActionsChanged(kick), store.onInboxChanged(kick), store.onApprovalsChanged(kick)]
  const poll = setInterval(fn, 60_000)
  return () => {
    clearTimeout(timer)
    clearInterval(poll)
    for (const off of offs) off()
  }
}

const PAGE = 50

/** One view of the log, newest first, with "older" paging. */
export function useJuniorLog(filter: LogFilter) {
  const [lines, setLines] = useState<LogLine[] | null>(null)
  const [more, setMore] = useState(false)
  const [latest, setLatest] = useState(0)
  // How many lines are on screen: a refetch keeps that many, so paging survives a live update.
  const shown = useRef(PAGE)
  const load = useCallback(async () => {
    const log = await fetchLog(filter, null, shown.current)
    if (!log) return
    setLines(log.lines)
    setMore(log.more)
    setLatest(log.latestAt)
  }, [filter])
  useEffect(() => {
    shown.current = PAGE
    setLines(null)
    void load()
    return onLogMoved(() => void load())
  }, [load])
  const older = useCallback(async () => {
    const last = lines?.at(-1)
    if (!last) return
    const log = await fetchLog(filter, last.at, PAGE)
    if (!log) return
    shown.current += log.lines.length
    setLines((prev) => [...(prev ?? []), ...log.lines])
    setMore(log.more)
  }, [filter, lines])
  return { lines, more, older, latestAt: latest }
}

/** Is there a line you haven't seen? The rail's dot on Junior. */
export function useLogUnread(): boolean {
  const [unread, setUnread] = useState(false)
  useEffect(() => {
    let alive = true
    const load = async () => {
      const log = await fetchLog('all', null, 0)
      if (alive && log) setUnread(log.latestAt > log.seenAt)
    }
    void load()
    const offSeen = onSeen(() => void load())
    const off = onLogMoved(() => void load())
    return () => {
      alive = false
      off()
      offSeen()
    }
  }, [])
  return unread
}

const seenListeners = new Set<() => void>()
const onSeen = (fn: () => void) => {
  seenListeners.add(fn)
  return () => void seenListeners.delete(fn)
}

/** You looked at the log up to `at`. */
export async function markLogSeen(at: number): Promise<void> {
  if (!at) return
  try {
    await fetch('/api/junior/log/seen', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ at }) })
  } catch {
    return
  }
  for (const fn of seenListeners) fn()
}

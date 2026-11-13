/**
 * Which finished threads you have looked at (.docs/redesign-b2-plan.md): a
 * thread that is ready makes Junior say "Review #477 is ready for you to look
 * at" until you open it. Per browser: thread id → the `updatedAt` you saw, so
 * new work on it makes it ready again.
 */
import { useSyncExternalStore } from 'react'

const KEY = 'junior.threads.seen'
/** Ids kept: the newest this many, so the map never grows without end. */
const KEEP = 200
const subs = new Set<() => void>()

function load(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {}
  } catch {
    return {}
  }
}

let seen: Record<string, number> = load()

export function markThreadSeen(id: string, updatedAt: number) {
  if ((seen[id] ?? 0) >= updatedAt) return
  const next = Object.entries({ ...seen, [id]: updatedAt })
    .sort((a, b) => b[1] - a[1])
    .slice(0, KEEP)
  seen = Object.fromEntries(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(seen))
  } catch {
    // storage blocked: seen for this page load only
  }
  for (const f of subs) f()
}

const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

/** Seen since its last change. */
export const useThreadSeen = (): ((id: string, updatedAt: number) => boolean) => {
  const map = useSyncExternalStore(subscribe, () => seen)
  return (id, updatedAt) => (map[id] ?? 0) >= updatedAt
}

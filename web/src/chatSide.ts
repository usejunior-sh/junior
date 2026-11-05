/**
 * The chat's right sidebar (variant F, artifact 9d492a83): which tab each chat
 * has open, per browser, surviving a reload. One slot per chat: the agent it
 * talks as (a DM's pill opens it), Changes, Artifacts, Background agents or
 * Browser, or nothing. The rail's icons switch it.
 *
 * The browser pane's open state lives here too (browser.ts maps onto it), so a
 * chat never shows the browser and another tab at once. The rules are pure
 * functions over a plain map, so they test without a DOM.
 */
import { useSyncExternalStore } from 'react'

export type SideTab = 'agent' | 'changes' | 'artifacts' | 'agents' | 'browser'
export type SideMap = Readonly<Record<string, SideTab>>

export const SIDE_TABS: readonly SideTab[] = ['agent', 'changes', 'artifacts', 'agents', 'browser']
const KEY = 'junior.chatSide'
const LAST_KEY = 'junior.chatSideLast'
/** The browser pane's old store: read once, so a chat with the browser open keeps it. */
const LEGACY_BROWSER_KEY = 'junior.browserOpen'
/** Chats remembered at most; the oldest are forgotten first. */
export const SIDE_CAP = 50

const isTab = (v: unknown): v is SideTab => typeof v === 'string' && (SIDE_TABS as readonly string[]).includes(v)

/** The stored map, or the old browser list as one, or nothing. Bad entries are dropped. */
export function parseSide(raw: string | null, legacyBrowser: string | null): SideMap {
  try {
    if (raw !== null) {
      const v: unknown = JSON.parse(raw)
      if (v && typeof v === 'object' && !Array.isArray(v))
        return capped(Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((e): e is [string, SideTab] => isTab(e[1]))))
      return {}
    }
    const old: unknown = JSON.parse(legacyBrowser ?? '[]')
    return Array.isArray(old) ? capped(Object.fromEntries(old.filter((x): x is string => typeof x === 'string').map((id) => [id, 'browser' as const]))) : {}
  } catch {
    return {}
  }
}

/** Keep the newest SIDE_CAP entries: insertion order is recency, since `withTab` re-inserts. */
function capped(m: Record<string, SideTab>): SideMap {
  const keys = Object.keys(m)
  return keys.length <= SIDE_CAP ? m : Object.fromEntries(keys.slice(-SIDE_CAP).map((k) => [k, m[k]]))
}

/** The map with one chat's tab set (moved to newest) or cleared (null). */
export function withTab(m: SideMap, sessionId: string, tab: SideTab | null): SideMap {
  const { [sessionId]: _drop, ...rest } = m
  return tab ? capped({ ...rest, [sessionId]: tab }) : rest
}

/** A header icon: open its tab, or close the sidebar when that tab is already showing. */
export function toggled(m: SideMap, sessionId: string, tab: SideTab): SideMap {
  return withTab(m, sessionId, m[sessionId] === tab ? null : tab)
}

/** The browser pane closing: clears the sidebar only when the browser is what it shows. */
export function browserClosed(m: SideMap, sessionId: string): SideMap {
  return m[sessionId] === 'browser' ? withTab(m, sessionId, null) : m
}

// ── the store ───────────────────────────────────────────────────────────────

const storage = typeof localStorage === 'undefined' ? null : localStorage
const read = (k: string) => {
  try {
    return storage?.getItem(k) ?? null
  } catch {
    return null
  }
}

let side: SideMap = parseSide(read(KEY), read(LEGACY_BROWSER_KEY))
let last: SideTab = (() => {
  const v = read(LAST_KEY)
  return isTab(v) && v !== 'browser' ? v : 'artifacts'
})()
const listeners = new Set<() => void>()

function commit(next: SideMap) {
  if (next === side) return
  side = next
  try {
    storage?.setItem(KEY, JSON.stringify(side))
  } catch {
    // storage blocked: this page load only
  }
  for (const fn of listeners) fn()
}

export const chatSide = {
  get: (sessionId: string): SideTab | null => side[sessionId] ?? null,
  set(sessionId: string, tab: SideTab | null) {
    if (tab && tab !== 'browser') remember(tab)
    commit(withTab(side, sessionId, tab))
  },
  toggle(sessionId: string, tab: SideTab) {
    if (tab !== 'browser') remember(tab)
    commit(toggled(side, sessionId, tab))
  },
  /** ⌘⌥B and the header's panel icon: hide what's showing, else open the tab used last. */
  toggleOpen(sessionId: string) {
    commit(withTab(side, sessionId, side[sessionId] ? null : last))
  },
  closeBrowser(sessionId: string) {
    commit(browserClosed(side, sessionId))
  },
  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },
}

function remember(tab: SideTab) {
  last = tab
  try {
    storage?.setItem(LAST_KEY, tab)
  } catch {
    // storage blocked
  }
}

export function useChatSide(sessionId: string | null): SideTab | null {
  return useSyncExternalStore(chatSide.subscribe, () => (sessionId ? (side[sessionId] ?? null) : null))
}

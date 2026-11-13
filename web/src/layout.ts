/**
 * Which shell the app draws (.docs/redesign-b2-plan.md): `team` is the
 * redesign, a sidebar with Junior, its agents and the open threads, and one
 * chat with Junior as home; `classic` is the icon rail, panels and tab band.
 * Per browser, so a phone and a Mac can differ. The sidebar's collapsed state
 * (⌘\) lives here too.
 */
import { useSyncExternalStore } from 'react'

export type Layout = 'team' | 'classic'

const LAYOUT_KEY = 'junior.layout'
const COLLAPSED_KEY = 'junior.sidebar.collapsed'
const subs = new Set<() => void>()

function read<T extends string>(key: string, ok: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v && (ok as readonly string[]).includes(v) ? (v as T) : fallback
  } catch {
    return fallback
  }
}

let layout: Layout = read<Layout>(LAYOUT_KEY, ['team', 'classic'], 'team')
let collapsed = read<'1' | '0'>(COLLAPSED_KEY, ['1', '0'], '0') === '1'

function write(key: string, v: string) {
  try {
    localStorage.setItem(key, v)
  } catch {
    // storage blocked: the choice lasts this page load
  }
  for (const f of subs) f()
}

const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

export const useLayout = (): Layout => useSyncExternalStore(subscribe, () => layout)
/** The layout outside React (hotkeys, the palette). The phone keeps classic whatever this says. */
export const getLayout = (): Layout => layout
export function setLayout(next: Layout) {
  layout = next
  write(LAYOUT_KEY, next)
}

export const useSidebarCollapsed = (): boolean => useSyncExternalStore(subscribe, () => collapsed)
export function setSidebarCollapsed(next: boolean) {
  collapsed = next
  write(COLLAPSED_KEY, next ? '1' : '0')
}
export const toggleSidebar = () => setSidebarCollapsed(!collapsed)

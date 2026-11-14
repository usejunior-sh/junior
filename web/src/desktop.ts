/**
 * Junior.app (desktop/): the Electron preload exposes `window.juniorDesktop`
 * on the daemon's pages. Present = the UI draws its own title bar, traffic
 * lights inside the top bar, ← → driving the window's history, instead of
 * the grey one macOS would add. Absent (a browser, a phone) = nothing changes.
 */
import { useEffect, useState } from 'react'

export type DesktopNav = { canGoBack: boolean; canGoForward: boolean; fullscreen: boolean }

type Bridge = {
  chrome: 'mac'
  back: () => void
  forward: () => void
  navState: () => Promise<DesktopNav>
  onNav: (cb: (s: DesktopNav) => void) => () => void
}

const bridge: Bridge | null = (() => {
  const b = (globalThis as { juniorDesktop?: Partial<Bridge> }).juniorDesktop
  return b?.chrome === 'mac' && typeof b.onNav === 'function' ? (b as Bridge) : null
})()

/** Running inside Junior.app's window. */
export const isDesktop = bridge !== null

if (bridge) document.documentElement.classList.add('desktop-mac')

export const goBack = () => bridge?.back()
export const goForward = () => bridge?.forward()

const IDLE: DesktopNav = { canGoBack: false, canGoForward: false, fullscreen: false }

/** ← → availability and fullscreen, pushed by the main process after every navigation. */
export function useDesktopNav(): DesktopNav {
  const [nav, setNav] = useState(IDLE)
  useEffect(() => {
    if (!bridge) return
    void bridge.navState().then(setNav)
    return bridge.onNav(setNav)
  }, [])
  return nav
}

/**
 * Workspace tabs (.docs/workspace-tabs/topbar-variations.html, B). Junior.app
 * hosts one view per open workspace; every view draws the strip from the
 * window's tab list, which the host pushes. Optional on purpose: an older app
 * build and the demo's stand-in bridge have no `tabs`, and keep the switcher.
 * Keep in step with desktop/src/tabs-model.ts.
 */
export type DesktopTab = {
  /** workspace id */
  id: string
  /** last shown, epoch ms: the least recent fold into "+N" first */
  lastActive: number
  /** destroyed after a while in the background; showing it reloads it */
  asleep: boolean
}

export type DesktopTabsState = {
  /** this window's tabs, in strip order */
  tabs: DesktopTab[]
  /** the tab in front in this window */
  active: string
  /** workspaces open in another window, and which */
  elsewhere: { id: string; windowId: number }[]
  /** every workspace's needs-you count (GET /api/workspaces/needs-you) */
  counts: Record<string, number>
}

/** What the app's menu asks the strip to do (⌘T opens the + menu). */
export type DesktopTabsCommand = 'open-menu'

type TabsBridge = {
  state: () => Promise<DesktopTabsState>
  onState: (cb: (s: DesktopTabsState) => void) => () => void
  onCommand: (cb: (c: DesktopTabsCommand) => void) => () => void
  /** open a workspace as a tab here (or its own window), or go to it where it already is */
  open: (id: string, opts?: { newWindow?: boolean }) => void
  activate: (id: string) => void
  close: (id: string) => void
  /** move a tab: to a new window (placed at a screen point, for a drag), or into this one */
  move: (id: string, to: 'new' | 'here', at?: { x: number; y: number }) => void
  /** this view's own needs-you count changed: refresh everyone's sooner */
  reportCount: (n: number) => void
}

const tabsBridge: TabsBridge | null = (() => {
  const t = (bridge as { tabs?: Partial<TabsBridge> } | null)?.tabs
  return t && typeof t.onState === 'function' && typeof t.open === 'function' ? (t as TabsBridge) : null
})()

/** Junior.app hosts workspace tabs: the bar draws them instead of the switcher. */
export const hasTabs = tabsBridge !== null
export const desktopTabs = tabsBridge

/** The window's tab list, live. Null outside the app or until the host answers. */
export function useDesktopTabs(): DesktopTabsState | null {
  const [s, setS] = useState<DesktopTabsState | null>(null)
  useEffect(() => {
    if (!tabsBridge) return
    void tabsBridge.state().then(setS)
    return tabsBridge.onState(setS)
  }, [])
  return s
}

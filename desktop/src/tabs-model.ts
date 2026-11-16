/**
 * Workspace tabs, as data (.docs/workspace-tabs/topbar-variations.html, B).
 * Pure: no Electron, time is always an argument, so test/desktop-tabs.test.ts
 * covers the rules. tabs.ts owns the views and calls in here.
 *
 * The rules:
 * - A workspace is open in one tab at most, across every window. Opening it
 *   again goes to the tab that has it.
 * - Closing a window's last tab closes the window.
 * - A tab in the background for a while sleeps: its view goes, its place and
 *   its count stay. Showing it wakes it.
 *
 * The state a window's views draw from is `DesktopTabsState` in
 * web/src/desktop.ts; keep the two in step.
 */

export type TabRec = {
  /** workspace id */
  id: string
  /** when it was last in front, or last left the front, epoch ms */
  lastActive: number
  asleep: boolean
}

export type WinRec = { tabs: TabRec[]; active: string }

export type TabsState = {
  tabs: TabRec[]
  active: string
  elsewhere: { id: string; windowId: number }[]
  counts: Record<string, number>
}

/** Saved across launches: each window's tabs, in order, and its front tab. */
export type SavedWindow = { tabs: string[]; active: string }

export class TabsModel {
  readonly windows = new Map<number, WinRec>()

  /** Which window has a workspace open, if any. */
  find(id: string): { winId: number; tab: TabRec } | null {
    for (const [winId, w] of this.windows) {
      const tab = w.tabs.find((t) => t.id === id)
      if (tab) return { winId, tab }
    }
    return null
  }

  addWindow(winId: number, ids: string[], active: string, now: number): void {
    const fresh = [...new Set(ids)].filter((id) => !this.find(id))
    const front = fresh.includes(active) ? active : (fresh[0] ?? '')
    this.windows.set(winId, { tabs: fresh.map((id) => ({ id, lastActive: now, asleep: false })), active: front })
  }

  removeWindow(winId: number): void {
    this.windows.delete(winId)
  }

  /**
   * Open a workspace in a window. Already open somewhere: it comes to the front
   * there, and that window is the answer. Else it is added after the front tab.
   */
  open(winId: number, id: string, now: number): { winId: number; added: boolean } {
    const at = this.find(id)
    if (at) {
      this.activate(at.winId, id, now)
      return { winId: at.winId, added: false }
    }
    const w = this.windows.get(winId)
    if (!w) throw new Error(`no window ${winId}`)
    const i = w.tabs.findIndex((t) => t.id === w.active)
    w.tabs.splice(i + 1, 0, { id, lastActive: now, asleep: false })
    this.activate(winId, id, now)
    return { winId, added: true }
  }

  /** Bring a tab to the front of its window. The one it replaces starts its background clock. */
  activate(winId: number, id: string, now: number): boolean {
    const w = this.windows.get(winId)
    const tab = w?.tabs.find((t) => t.id === id)
    if (!w || !tab) return false
    const prev = w.tabs.find((t) => t.id === w.active)
    if (prev && prev !== tab) prev.lastActive = now
    w.active = id
    tab.lastActive = now
    tab.asleep = false
    return true
  }

  /**
   * Close a tab. The front tab hands over to its right-hand neighbour, else
   * its left. The last one closes the window.
   */
  close(winId: number, id: string, now: number): { closeWindow: boolean } {
    const w = this.windows.get(winId)
    if (!w) return { closeWindow: false }
    const i = w.tabs.findIndex((t) => t.id === id)
    if (i === -1) return { closeWindow: false }
    if (w.tabs.length === 1) return { closeWindow: true }
    w.tabs.splice(i, 1)
    if (w.active === id) this.activate(winId, w.tabs[Math.min(i, w.tabs.length - 1)].id, now)
    return { closeWindow: false }
  }

  /** Take a tab out of its window into another; it arrives in front. The window it leaves may now be empty. */
  move(id: string, toWinId: number, now: number): { from: number; emptied: boolean } | null {
    const at = this.find(id)
    const to = this.windows.get(toWinId)
    if (!at || !to || at.winId === toWinId) return null
    const from = this.windows.get(at.winId)!
    if (from.tabs.length === 1) {
      from.tabs = []
      from.active = ''
    } else this.close(at.winId, id, now)
    to.tabs.push({ ...at.tab, asleep: false })
    this.activate(toWinId, id, now)
    return { from: at.winId, emptied: from.tabs.length === 0 }
  }

  /** The workspace in a window's tab changed under it (the daemon fell back to another). */
  rename(winId: number, from: string, to: string): 'renamed' | 'duplicate' | 'none' {
    const w = this.windows.get(winId)
    const tab = w?.tabs.find((t) => t.id === from)
    if (!w || !tab || from === to) return 'none'
    if (this.find(to)) return 'duplicate'
    tab.id = to
    if (w.active === from) w.active = to
    return 'renamed'
  }

  /**
   * The front tab's "Switch to": a tab shows another workspace, in its place,
   * and comes to the front. False when that workspace is open already (go to
   * it with `open` instead) or there is no such tab.
   */
  swap(winId: number, from: string, to: string, now: number): boolean {
    if (this.rename(winId, from, to) !== 'renamed') return false
    this.activate(winId, to, now)
    return true
  }

  /** Background tabs that have been out of sight for `afterMs` and still hold a view. */
  sleepers(now: number, afterMs: number): { winId: number; id: string }[] {
    const out: { winId: number; id: string }[] = []
    for (const [winId, w] of this.windows)
      for (const t of w.tabs) if (t.id !== w.active && !t.asleep && now - t.lastActive >= afterMs) out.push({ winId, id: t.id })
    return out
  }

  /** The next or previous tab in a window, wrapping (⌃Tab / ⌃⇧Tab), or the nth (⌃1–9; 9 is the last). */
  step(winId: number, by: 1 | -1): string | null {
    const w = this.windows.get(winId)
    if (!w || !w.tabs.length) return null
    const i = w.tabs.findIndex((t) => t.id === w.active)
    return w.tabs[(i + by + w.tabs.length) % w.tabs.length].id
  }

  nth(winId: number, n: number): string | null {
    const w = this.windows.get(winId)
    if (!w || !w.tabs.length) return null
    return n >= 9 ? w.tabs[w.tabs.length - 1].id : (w.tabs[n - 1]?.id ?? null)
  }

  /** What a window's views draw. */
  stateFor(winId: number, counts: Record<string, number>): TabsState {
    const w = this.windows.get(winId) ?? { tabs: [], active: '' }
    const elsewhere: TabsState['elsewhere'] = []
    for (const [other, o] of this.windows) if (other !== winId) for (const t of o.tabs) elsewhere.push({ id: t.id, windowId: other })
    return { tabs: w.tabs.map((t) => ({ ...t })), active: w.active, elsewhere, counts }
  }

  save(order: number[]): SavedWindow[] {
    return order
      .map((winId) => this.windows.get(winId))
      .filter((w): w is WinRec => !!w && w.tabs.length > 0)
      .map((w) => ({ tabs: w.tabs.map((t) => t.id), active: w.active }))
  }
}

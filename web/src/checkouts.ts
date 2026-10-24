/**
 * Checkouts on the client: a project's folders (main + worktrees), named by
 * id from sessions and terminals, plus the editors "Open in…" can use — and
 * opening one file a session wrote in the last of them.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { Checkout, ContextOpenResponse, Editor, EditorsResponse, OpenCheckoutResponse, OpenFileResponse } from '../../shared/protocol.js'

export const checkoutOf = (checkouts: readonly Checkout[], id: string | undefined | null): Checkout | undefined =>
  id ? checkouts.find((c) => c.id === id) : undefined

/** A worktree's branch without its kind prefix, `fix/model-list-cache` → `model-list-cache`, for tight spots like tabs. */
export const branchSlug = (branch: string) => branch.slice(branch.lastIndexOf('/') + 1)

/** What a checkout is called in one word: its branch, else that it's detached. */
export const checkoutLabel = (c: Checkout) => c.branch ?? 'detached'

// editors: detected once per page load, the last one used listed first

const lastKey = 'junior.editor.last'
let editors: readonly Editor[] = []
let loaded = false
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function load(): Promise<void> {
  inflight ??= fetch('/api/editors')
    .then((r) => r.json() as Promise<EditorsResponse>)
    .then((b) => {
      editors = lastFirst(b.ok ? b.editors : [])
    })
    .catch(() => {
      editors = []
    })
    .finally(() => {
      loaded = true
      for (const fn of listeners) fn()
    })
  return inflight
}

function lastEditor(): string | null {
  try {
    return localStorage.getItem(lastKey)
  } catch {
    return null
  }
}

function lastFirst(list: readonly Editor[]): readonly Editor[] {
  const i = list.findIndex((e) => e.id === lastEditor())
  return i > 0 ? [list[i], ...list.slice(0, i), ...list.slice(i + 1)] : list
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** The editors on this machine, the last one used first. Fetched on first use. */
export function useEditors(): readonly Editor[] {
  useEffect(() => {
    if (!loaded) void load()
  }, [])
  return useSyncExternalStore(subscribe, () => editors)
}

/** Open a checkout's folder in an editor (or `finder`). Resolves to an error message, or null. */
export async function openCheckout(checkoutId: string, editor: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/checkouts/${encodeURIComponent(checkoutId)}/open`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ editor }),
    })
    const b = (await res.json()) as OpenCheckoutResponse
    if (!b.ok) return b.error
    if (editor !== 'finder') {
      try {
        localStorage.setItem(lastKey, editor)
        editors = lastFirst(editors)
        for (const fn of listeners) fn()
      } catch {
        // storage blocked: the order just doesn't stick
      }
    }
    return null
  } catch (err) {
    return String(err)
  }
}

/**
 * Open a file a session wrote in the editor "Open in…" last used; the daemon
 * falls back to the first editor it finds, then the OS default. Resolves to an
 * error message, or null.
 */
export async function openSessionFile(sessionId: string, file: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/open-file`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file, editor: lastEditor() ?? undefined }),
    })
    const b = (await res.json()) as OpenFileResponse
    return b.ok ? null : b.error
  } catch (err) {
    return String(err)
  }
}

/**
 * Open a context file (`/remember`'s target) in the editor "Open in…" last
 * used. Resolves to an error message, or null.
 */
export async function openContextFile(scope: 'project' | 'workspace', projectId?: string): Promise<string | null> {
  try {
    const res = await fetch('/api/context/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope, projectId, editor: lastEditor() ?? undefined }),
    })
    const b = (await res.json()) as ContextOpenResponse
    return b.ok ? null : b.error
  } catch (err) {
    return String(err)
  }
}

/**
 * Session drafts: a "New session" tab before it is a session. A draft holds
 * the prompt being written, the folder it will run in, and (when it came from
 * the inbox) the item it dispatches. Drafts are per browser and per
 * workspace, sending one turns it into a real session on the server, and the
 * draft is discarded, so they live in localStorage, not the daemon.
 */
import { useSyncExternalStore } from 'react'
import type { Mention } from '../../shared/protocol.js'
import { uuid } from './uuid.js'

export type Draft = {
  id: string
  /** shown on the tab while the prompt is empty. The dispatched item's title, or "New chat" */
  label?: string
  text: string
  cwd?: string
  /** `@` mentions the draft opens with (a dispatched item, its brief). The tokens are in `text` */
  mentions?: Mention[]
  /** the work item this draft dispatches; recorded as a link when the session starts */
  itemId?: string
  /** run in this existing checkout (a worktree) instead of the project's main folder */
  checkoutId?: string
  /** run in a new worktree on this branch, set = "New worktree" is picked; wins over checkoutId */
  newBranch?: string
  /** a dispatched item's branch name, offered if you pick "New worktree", never picked for you */
  branchHint?: string
  /** a live worktree already made for the dispatched item, offered as "Continue in …" */
  continueIn?: string
  /** `job` = "New job": a chat with Junior that sets one up, its first message prefixed "New job:"; `goal` = the same for a goal ("New goal:") */
  intent?: 'job' | 'goal'
  createdAt: number
}

const key = (workspaceId: string) => `triage.drafts.${workspaceId || 'default'}`

let wsId = ''
let drafts: readonly Draft[] = []
const listeners = new Set<() => void>()

function notify() {
  for (const fn of listeners) fn()
}

function persist() {
  try {
    localStorage.setItem(key(wsId), JSON.stringify(drafts))
  } catch {
    // storage blocked: drafts still work for this page load
  }
}

function load(workspaceId: string): readonly Draft[] {
  try {
    const raw = localStorage.getItem(key(workspaceId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter(
          (d): d is Draft =>
            typeof d === 'object' && d !== null && typeof (d as Draft).id === 'string' && typeof (d as Draft).text === 'string',
        )
      : []
  } catch {
    return []
  }
}

export const draftStore = {
  get: () => drafts,

  subscribe(fn: () => void) {
    listeners.add(fn)
    return () => {
      listeners.delete(fn)
    }
  },

  /** Rebind to a workspace (the page reloads on a switch, but stay correct regardless). */
  bind(workspaceId: string) {
    if (workspaceId === wsId) return
    wsId = workspaceId
    drafts = load(workspaceId)
    notify()
  },

  create(init: Partial<Omit<Draft, 'id' | 'createdAt'>> = {}): Draft {
    const d: Draft = { id: uuid(), text: '', createdAt: Date.now(), ...init }
    drafts = [...drafts, d]
    persist()
    notify()
    return d
  },

  update(id: string, patch: Partial<Omit<Draft, 'id' | 'createdAt'>>) {
    drafts = drafts.map((d) => (d.id === id ? { ...d, ...patch } : d))
    persist()
    notify()
  },

  remove(id: string) {
    if (!drafts.some((d) => d.id === id)) return
    drafts = drafts.filter((d) => d.id !== id)
    persist()
    notify()
  },

  /** An untouched draft: `n` focuses it rather than stacking blank tabs. */
  findEmpty(): Draft | undefined {
    return drafts.find((d) => !d.text.trim() && !d.label && !d.intent)
  },

  /** An untouched "New job" draft, reused like an empty session draft. */
  findEmptyJob(): Draft | undefined {
    return drafts.find((d) => !d.text.trim() && d.intent === 'job')
  },
}

export function useDrafts(): readonly Draft[] {
  return useSyncExternalStore(draftStore.subscribe, draftStore.get)
}

/** The tab / panel title for a draft. */
export function draftTitle(d: Draft): string {
  if (d.label) return d.label
  const line = d.text.trim().split('\n')[0]
  return line ? (line.length > 48 ? line.slice(0, 47) + '…' : line) : d.intent === 'job' ? 'New job' : d.intent === 'goal' ? 'New goal' : 'New chat'
}

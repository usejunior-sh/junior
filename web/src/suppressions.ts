/**
 * "Not this one", with a reason, on the client (core/junior/suggest.ts,
 * server/handoff-ops.ts): say why on an item, and the list of kinds Junior
 * stopped suggesting, behind Junior's notebook and the Suggested footer. One
 * shared copy, loaded when something that shows it mounts, refreshed after our
 * own reason or clear and on `inbox_changed` (like weights.ts).
 */
import { useEffect, useState } from 'react'
import type { NotNowReason, NotNowReasonResponse, Suppression, SuppressionsResponse } from '../../shared/protocol.js'
import { inboxStore } from './inboxStore.js'
import { store } from './store.js'

type State = { suppressions: Suppression[] | null; error: string | null }

let state: State = { suppressions: null, error: null }
const subs = new Set<(s: State) => void>()
let offInbox: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | undefined

const emit = (next: State) => {
  state = next
  for (const fn of subs) fn(state)
}

async function load(): Promise<void> {
  try {
    const body = (await (await fetch('/api/suggest/suppressions')).json()) as SuppressionsResponse
    if (body.ok) emit({ suppressions: body.suppressions, error: null })
    else emit({ ...state, error: body.error })
  } catch (err) {
    if (!state.suppressions) emit({ ...state, error: String(err) })
  }
}

/** Every kind Junior stopped suggesting, newest first; null until the first load. */
export function useSuppressions(): State {
  const [s, setS] = useState<State>(state)
  useEffect(() => {
    subs.add(setS)
    if (!offInbox)
      offInbox = store.onInboxChanged(() => {
        clearTimeout(timer)
        timer = setTimeout(() => void load(), 300)
      })
    void load()
    return () => {
      subs.delete(setS)
      if (!subs.size && offInbox) {
        offInbox()
        offInbox = null
        clearTimeout(timer)
      }
    }
  }, [])
  return s
}

export type ReasonAnswer = { ok: true; suppression: Suppression | null } | { ok: false; error: string }

/** Say why not this one. The answer names the suppression it made, when it made one. */
export async function sayWhy(itemId: string, reason: NotNowReason): Promise<ReasonAnswer> {
  try {
    const res = await fetch('/api/handoff/reason', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId, reason }) })
    const b = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as NotNowReasonResponse
    if (!b.ok) return { ok: false, error: b.error }
    inboxStore.patch((items) => items.map((i) => (i.id === itemId ? { ...i, notNowReason: b.item.notNowReason } : i)))
    if (b.suppression) void load()
    return { ok: true, suppression: b.suppression }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Clear one: Junior suggests that kind in that repo again. */
export async function clearSuppression(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/suggest/suppressions/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })
    const b = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as SuppressionsResponse
    if (!b.ok) return { ok: false, error: b.error }
    emit({ suppressions: b.suppressions, error: null })
    void inboxStore.refreshAfterChange()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

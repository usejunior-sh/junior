/**
 * Learnings on the client (core/junior/learnings.ts, /api/learnings): the list
 * behind the Learned group in Junior's notebook and every "Learned: …" line in
 * a chat. One shared copy: loaded when something that shows it mounts,
 * patched after our own keep/edit/forget, and refetched on `learnings_changed`.
 */
import { useEffect, useState } from 'react'
import type { Learning, LearningResponse, LearningsResponse } from '../../shared/protocol.js'
import { store } from './store.js'

export type LearningsState = {
  learnings: Learning[] | null
  broken: { id: string; file: string; errors: string[] }[]
  path: string
  /** ms: when the list was last read from the server; 0 before */
  loadedAt: number
  error: string | null
}

let state: LearningsState = { learnings: null, broken: [], path: '', loadedAt: 0, error: null }
const subs = new Set<(s: LearningsState) => void>()
let off: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | undefined

const emit = (next: LearningsState) => {
  state = next
  for (const fn of subs) fn(state)
}

async function load(): Promise<void> {
  const startedAt = Date.now()
  try {
    const body = (await (await fetch('/api/learnings')).json()) as LearningsResponse
    if (body.ok) emit({ learnings: body.learnings, broken: body.broken, path: body.path, loadedAt: startedAt, error: null })
    else emit({ ...state, error: body.error })
  } catch (err) {
    // offline: keep the last list, say why only when there's none
    if (!state.learnings) emit({ ...state, error: String(err) })
  }
}

/** Proposed, kept and stale learnings (newest made first), null until the first load. */
export function useLearnings(): LearningsState {
  const [s, setS] = useState<LearningsState>(state)
  useEffect(() => {
    subs.add(setS)
    setS(state)
    if (!off) {
      off = store.onLearningsChanged(() => {
        clearTimeout(timer)
        timer = setTimeout(() => void load(), 150)
      })
      void load()
    }
    return () => {
      subs.delete(setS)
      if (!subs.size && off) {
        off()
        off = null
        clearTimeout(timer)
      }
    }
  }, [])
  return s
}

export type LearningAnswer = { ok: true; learning: Learning } | { ok: false; error: string }

async function post(op: 'keep' | 'edit' | 'forget', body: Record<string, unknown>): Promise<LearningAnswer> {
  try {
    const res = await fetch(`/api/learnings/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const b = (await res.json()) as LearningResponse
    if (!b.ok) return { ok: false, error: b.error }
    // patch now; the `learnings_changed` that follows refetches the whole list
    if (state.learnings) {
      const list = op === 'forget' ? state.learnings.filter((l) => l.id !== b.learning.id) : state.learnings.map((l) => (l.id === b.learning.id ? b.learning : l))
      emit({ ...state, learnings: list })
    }
    return { ok: true, learning: b.learning }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/** You said keep: it loads into chats and runs from now on. */
export const keepLearning = (id: string) => post('keep', { id })
/** New words. `confirm` saves an edit that cuts more than half. Editing never keeps it. */
export const editLearning = (id: string, text: string, confirm = false) => post('edit', { id, text, ...(confirm ? { confirm: true } : {}) })
/** Undo or Forget: the file goes, and Junior won't use it. */
export const forgetLearning = (id: string) => post('forget', { id })

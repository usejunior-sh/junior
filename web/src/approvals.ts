/**
 * Advance approvals on the client (core/approvals): the list behind Settings →
 * Approvals and every Rule card, kept current by `approvals_changed`.
 */
import { useEffect, useState } from 'react'
import type { AdvanceApproval } from '../../core/approvals/approvals.js'
import { store } from './store.js'

type ListResponse = { ok: true; approvals: AdvanceApproval[] } | { ok: false; error: string }
type OneResponse = { ok: true; approval: AdvanceApproval } | { ok: false; error: string }

/** Every approval, revoked ones included, newest first; null until the first load. */
export function useApprovals(): AdvanceApproval[] | null {
  const [list, setList] = useState<AdvanceApproval[] | null>(null)
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const body = (await (await fetch('/api/approvals')).json()) as ListResponse
        if (alive && body.ok) setList(body.approvals)
      } catch {
        // offline: keep the last list
      }
    }
    void load()
    const off = store.onApprovalsChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(() => void load(), 150)
    })
    return () => {
      alive = false
      off()
      clearTimeout(timer)
    }
  }, [])
  return list
}

async function post(path: string, body: unknown): Promise<OneResponse> {
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return (await res.json()) as OneResponse
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export const addApproval = (body: Record<string, unknown>) => post('/api/approvals', body)
export const revokeApproval = (id: string) => post('/api/approvals/revoke', { id })

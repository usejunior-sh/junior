import { useCallback, useEffect, useState } from 'react'
import type { ItemDetailResponse } from '../../../../shared/protocol.js'
import type { ItemTask } from '../../../../core/work/tasks.js'
import { useInbox } from '../../inboxStore.js'

export type TaskVerb = 'approve' | 'retry' | 'stop' | 'skip' | 'post-review' | 'review-again' | 'send-reply' | 'approve-plan' | 'change-plan' | 'go-ahead' | 'look-again' | 'send-bot-replies'

/** POST /api/tasks/<verb>: null when it went through, else what went wrong. */
export async function taskVerb(verb: TaskVerb, body: Record<string, unknown>): Promise<string | null> {
  const r = await fetch(`/api/tasks/${verb}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const b = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as { ok: boolean; error?: string }
  return b.ok ? null : (b.error ?? 'failed')
}

/**
 * The item's tasks (core/work/tasks.ts), shared by the verdict and every tab.
 * Every inbox change may be a task moving; while one runs or waits to run,
 * look again every few seconds too.
 */
export function useItemTasks(itemId: string): { tasks: ItemTask[] | null; reload: () => void } {
  const snap = useInbox()
  const [tasks, setTasks] = useState<ItemTask[] | null>(null)

  const reload = useCallback(() => {
    void fetch(`/api/items/detail?id=${encodeURIComponent(itemId)}`)
      .then((r) => r.json() as Promise<ItemDetailResponse>)
      .then((b) => setTasks(b.ok ? b.detail.tasks : []))
      .catch(() => setTasks([]))
  }, [itemId])

  useEffect(reload, [reload, snap.syncedAt])
  const moving = tasks?.some((t) => t.state === 'running' || t.state === 'queued') ?? false
  useEffect(() => {
    if (!moving) return
    const t = setInterval(reload, 5_000)
    return () => clearInterval(t)
  }, [moving, reload])

  return { tasks, reload }
}

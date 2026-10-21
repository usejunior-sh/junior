import { useCallback, useEffect, useState } from 'react'
import type { ItemDetailResponse } from '../../../../shared/protocol.js'
import type { ItemTask } from '../../../../core/work/tasks.js'
import { requestCommands } from '../../../../core/babysit/reviewer.js'
import { useInbox } from '../../inboxStore.js'

/** One glyph per state, read at a glance down the column. */
const MARK: Record<ItemTask['state'], string> = {
  queued: '○',
  running: '◐',
  waiting: '!',
  done: '✓',
  failed: '×',
  skipped: '–',
  stopped: '■',
}

const STATE_WORD: Record<ItemTask['state'], string> = {
  queued: 'next',
  running: 'working',
  waiting: 'needs you',
  done: 'done',
  failed: 'stuck',
  skipped: 'skipped',
  stopped: 'stopped',
}

const prOf = (itemId: string) => {
  const m = /^github:([\w.-]+\/[\w.-]+)#(\d+)$/.exec(itemId)
  return m ? { repo: m[1]!, number: Number(m[2]) } : null
}

async function post(verb: 'approve' | 'retry' | 'stop' | 'skip', body: Record<string, string>): Promise<string | null> {
  const r = await fetch(`/api/tasks/${verb}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const b = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as { ok: boolean; error?: string }
  return b.ok ? null : (b.error ?? 'failed')
}

/**
 * The item's task list (core/work/tasks.ts): what Junior did, is doing and
 * waits on you for. Dense rows, oldest first. A reviewer request shows the
 * exact commands it runs, so Request is your OK to those, word for word.
 */
export function ItemTasks({ itemId, onNavigate }: { itemId: string; onNavigate: (hash: string) => void }) {
  const snap = useInbox()
  const [tasks, setTasks] = useState<ItemTask[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reviewer, setReviewer] = useState<Record<string, string>>({})

  const load = useCallback(() => {
    void fetch(`/api/items/detail?id=${encodeURIComponent(itemId)}`)
      .then((r) => r.json() as Promise<ItemDetailResponse>)
      .then((b) => setTasks(b.ok ? b.detail.tasks : []))
      .catch(() => setTasks([]))
  }, [itemId])

  // Every inbox change may be a task moving; while one runs, look again every few seconds too.
  useEffect(load, [load, snap.syncedAt])
  const running = tasks?.some((t) => t.state === 'running' || t.state === 'queued') ?? false
  useEffect(() => {
    if (!running) return
    const t = setInterval(load, 5_000)
    return () => clearInterval(t)
  }, [running, load])

  if (!tasks || tasks.length === 0) return null

  const act = async (verb: 'approve' | 'retry' | 'stop' | 'skip', t: ItemTask, extra: Record<string, string> = {}) => {
    setBusy(t.id)
    setError(null)
    const err = await post(verb, { id: t.id, ...extra })
    setBusy(null)
    if (err) setError(err)
    load()
  }

  const pr = prOf(itemId)
  return (
    <section className="taskList" aria-label="Tasks">
      <div className="secLabel mute">
        Tasks <span className="n">{tasks.filter((t) => t.state === 'done').length} of {tasks.filter((t) => t.state !== 'skipped').length}</span>
      </div>
      {tasks.map((t) => {
        const ask = t.step === 'request-review' && t.state === 'waiting'
        const who = reviewer[t.id] ?? (typeof t.input?.reviewer === 'string' ? t.input.reviewer : '')
        let cmds: string[] = []
        try {
          cmds = ask && pr && who ? requestCommands(pr, who, t.input?.draft === true).map((c) => `gh ${c.join(' ')}`) : []
        } catch {
          cmds = []
        }
        return (
          <div key={t.id} className={`taskRow st-${t.state}`}>
            <span className="mk" aria-label={STATE_WORD[t.state]}>
              {MARK[t.state]}
            </span>
            <div className="body">
              <div className="top">
                <span className="ti">{t.title}</span>
                {t.whyDetail && <span className="why">{t.whyDetail}</span>}
                <span className="sw">
                  {t.owner === 'you' && t.state === 'waiting' ? 'yours' : STATE_WORD[t.state]}
                  {t.costUsd ? ` · $${t.costUsd.toFixed(2)}` : ''}
                </span>
              </div>
              {t.output?.summary && (
                <div className="out">
                  {t.output.summary}
                  {t.output.sha ? <span className="sha"> {t.output.sha.slice(0, 7)}</span> : null}
                </div>
              )}
              {t.error && (t.state === 'failed' || t.state === 'waiting' || t.state === 'stopped') && <div className="err">{t.error}</div>}
              {ask && (
                <div className="ask">
                  <input
                    className="reviewer"
                    value={who}
                    placeholder="GitHub login"
                    aria-label="Reviewer"
                    onChange={(e) => setReviewer((r) => ({ ...r, [t.id]: e.target.value.trim() }))}
                  />
                  <button type="button" className="btn xs primary" disabled={busy === t.id || !who || cmds.length === 0} onClick={() => void act('approve', t, { reviewer: who })}>
                    Request
                  </button>
                  <button type="button" className="btn xs ghost" disabled={busy === t.id} onClick={() => void act('skip', t)}>
                    Not now
                  </button>
                  {cmds.length > 0 && <code className="cmds">{cmds.join('  &&  ')}</code>}
                </div>
              )}
              <div className="acts">
                {t.sessionId && (
                  <a
                    href={`#${t.sessionId}`}
                    onClick={(e) => {
                      e.preventDefault()
                      onNavigate(t.sessionId!)
                    }}
                  >
                    Session
                  </a>
                )}
                {t.state === 'running' && (
                  <button type="button" className="btn xs ghost" disabled={busy === t.id} onClick={() => void act('stop', t)}>
                    Stop
                  </button>
                )}
                {(t.state === 'queued' || (t.state === 'waiting' && !ask)) && (
                  <button type="button" className="btn xs ghost" disabled={busy === t.id} onClick={() => void act('skip', t)}>
                    Skip
                  </button>
                )}
                {t.owner === 'junior' && (t.state === 'failed' || t.state === 'waiting') && (
                  <button type="button" className="btn xs ghost" disabled={busy === t.id} onClick={() => void act('retry', t)}>
                    Retry
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      })}
      {error && <div className="notice">{error}</div>}
    </section>
  )
}

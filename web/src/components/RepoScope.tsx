/**
 * Which GitHub repos this workspace's inbox pulls from. Empty = no GitHub
 * items: scope is opt-in per workspace (.docs/workspaces.md). Used inline
 * by the Sources settings tab and inside the inbox's repo dialog.
 */
import { useEffect, useMemo, useState } from 'react'
import type { ReposResponse } from '../../../shared/protocol.js'

type PickerState =
  | { phase: 'loading' }
  | { phase: 'ready'; available: string[] }
  | { phase: 'error'; message: string }

export function RepoScopeEditor({
  onSaved,
  onCancel,
}: {
  /** after a successful save, with how many repos are now connected */
  onSaved: (count: number) => void
  /** shown as a Cancel button when given (dialogs); settings tabs omit it */
  onCancel?: () => void
}) {
  const [state, setState] = useState<PickerState>({ phase: 'loading' })
  const [connected, setConnected] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void fetch('/api/repos')
      .then((r) => r.json() as Promise<ReposResponse>)
      .then((b) => {
        if (b.ok) {
          // connected repos surface first, and stay listed even if no longer affiliated
          const rest = b.available.filter((r) => !b.connected.includes(r))
          setState({ phase: 'ready', available: [...b.connected, ...rest] })
          setConnected(b.connected)
          setSelected(new Set(b.connected))
        } else {
          setState({ phase: 'error', message: b.error })
        }
      })
      .catch((err) => setState({ phase: 'error', message: String(err) }))
  }, [])

  const shown = useMemo(() => {
    if (state.phase !== 'ready') return []
    const q = filter.trim().toLowerCase()
    return q ? state.available.filter((r) => r.toLowerCase().includes(q)) : state.available
  }, [state, filter])

  const dirty = useMemo(() => {
    if (selected.size !== connected.length) return true
    return connected.some((r) => !selected.has(r))
  }, [selected, connected])

  function toggle(repo: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(repo)) next.delete(repo)
      else next.add(repo)
      return next
    })
  }

  async function save() {
    setSaving(true)
    setError('')
    try {
      const repos = [...selected].sort()
      const res = await fetch('/api/repos', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repos }),
      })
      const body = (await res.json()) as ReposResponse
      if (body.ok) {
        setConnected(body.connected)
        onSaved(body.connected.length)
      } else setError(body.error)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="repoScope">
      {state.phase === 'loading' && <div className="pickerLoading">Loading your repos…</div>}
      {state.phase === 'error' && <div className="msg error">{state.message}</div>}
      {state.phase === 'ready' && (
        <>
          <input
            className="pickerFilter"
            placeholder="Filter repos…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="pickerList">
            {shown.map((repo) => (
              <label key={repo} className="pickerRow">
                <input type="checkbox" checked={selected.has(repo)} onChange={() => toggle(repo)} />
                <span>{repo}</span>
              </label>
            ))}
            {shown.length === 0 && <div className="pickerLoading">No repos match.</div>}
          </div>
          <div className="pickerCount">
            {selected.size === 0 ? 'no repos — no GitHub items' : `${selected.size} selected`}
            {selected.size > 0 && (
              <button type="button" className="clearSel" onClick={() => setSelected(new Set())}>
                clear
              </button>
            )}
          </div>
        </>
      )}
      {error && <div className="msg error">{error}</div>}
      <div className="row">
        {onCancel && (
          <button type="button" className="btn cancel" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button
          type="button"
          className="btn primary go"
          disabled={state.phase !== 'ready' || saving || (!onCancel && !dirty)}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}

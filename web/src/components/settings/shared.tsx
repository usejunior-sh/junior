import { type ReactNode, useState, useEffect, useCallback } from 'react'
import type { WorkspaceSettings, SettingsResponse } from '../../../../shared/protocol.js'

export const Loading = () => <div className="pickerLoading">Loading…</div>

// ---------------------------------------------------------------------------
// Building blocks — a section with a heading, and a row: label left, control right.
// ---------------------------------------------------------------------------

export function Section({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="setSection">
      <h3>{title}</h3>
      {hint && <p className="hint">{hint}</p>}
      {children}
    </section>
  )
}

export function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="setRow">
      <div className="lbl">
        <b>{label}</b>
        {hint && <small>{hint}</small>}
      </div>
      <div className="ctl">{children}</div>
    </div>
  )
}

/** A save button plus a fading "Saved" — one idiom for every form here. */
export function SaveRow({
  dirty,
  saving,
  saved,
  error,
  onSave,
  label = 'Save',
  children,
}: {
  dirty: boolean
  saving: boolean
  saved: boolean
  error?: string
  onSave: () => void
  label?: string
  children?: ReactNode
}) {
  return (
    <>
      {error && <div className="msg error">{error}</div>}
      <div className="setActions">
        <button type="button" className="btn primary" disabled={!dirty || saving} onClick={onSave}>
          {saving ? 'Saving…' : label}
        </button>
        {saved && !dirty && <span className="saved">Saved</span>}
        {children}
      </div>
    </>
  )
}

export function useSavedFlash(): [boolean, () => void] {
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    if (!saved) return
    const t = setTimeout(() => setSaved(false), 2500)
    return () => clearTimeout(t)
  }, [saved])
  return [saved, () => setSaved(true)]
}

/** The workspace's server-side knobs (GET/PUT /api/settings), shared by two tabs. */
export function useWorkspaceSettings() {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json() as Promise<SettingsResponse>)
      .then((b) => (b.ok ? setSettings(b.settings) : setError(b.error)))
      .catch((e) => setError(String(e)))
  }, [])
  const save = useCallback(async (patch: Partial<WorkspaceSettings>) => {
    setError(null)
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
      const b = (await res.json()) as SettingsResponse
      if (b.ok) setSettings(b.settings)
      else setError(b.error)
    } catch (e) {
      setError(String(e))
    }
  }, [])
  return { settings, error, save }
}

// ---------------------------------------------------------------------------
// Appearance — theme and text size (per browser).
// ---------------------------------------------------------------------------

/** A pill of mutually-exclusive options — the same idiom as the inbox filter. */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (v: T) => void
  ariaLabel: string
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={o.value === value ? 'on' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { type AdvanceApproval, describeApproval, isLive } from '../../../../core/approvals/approvals.js'
import { revokeApproval, useApprovals } from '../../approvals.js'
import { spanText } from '../../actions.js'
import { Loading, Section } from './shared.js'
import { store } from '../../store.js'

// Approvals: the OKs you gave before the send (core/approvals). Junior proposes
// them in chat; you add them there and revoke them here.

export function ApprovalsTab() {
  const list = useApprovals()
  const [showPast, setShowPast] = useState(false)
  if (!list) return <Loading />
  const now = Date.now()
  const live = list.filter((a) => isLive(a, now))
  const past = list.filter((a) => !isLive(a, now))
  return (
    <>
      <Section
        title="Approved in advance"
        hint="Sends Junior may make without a card: one person or channel, one kind of send. Anything else still waits for your OK. Junior proposes these in chat; you add them there."
      >
        {live.length ? (
          <ul className="apList">
            {live.map((a) => (
              <ApprovalRow key={a.id} a={a} now={now} />
            ))}
          </ul>
        ) : (
          <p className="apEmpty">None yet. Every send waits for your OK on a card.</p>
        )}
      </Section>
      {past.length > 0 && (
        <Section title="Revoked and expired" hint="Kept so Junior’s log can still say what allowed a send.">
          {showPast ? (
            <ul className="apList past">
              {past.map((a) => (
                <ApprovalRow key={a.id} a={a} now={now} />
              ))}
            </ul>
          ) : (
            <button type="button" className="btn sm" onClick={() => setShowPast(true)}>
              Show {past.length}
            </button>
          )}
        </Section>
      )}
      <WhatCounts />
    </>
  )
}

type Sends = { path: string; errors: string[]; action: string[]; notAction: string[] }

/**
 * What counts as a send: the actions file's overrides. "Not a send" on a log
 * line adds to not_action; remove an entry here and those calls count again.
 */
function WhatCounts() {
  const [s, setS] = useState<Sends | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const body = (await (await fetch('/api/approvals/sends')).json()) as ({ ok: true } & Sends) | { ok: false; error: string }
        if (alive && body.ok) setS(body)
      } catch {
        // offline: keep the last read
      }
    }
    void load()
    const off = store.onActionsChanged(() => void load())
    return () => {
      alive = false
      off()
    }
  }, [])
  async function remove(key: 'action' | 'not_action', entry: string) {
    setErr(null)
    try {
      const res = await fetch('/api/approvals/sends', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, entry }) })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!body.ok) setErr(body.error ?? 'could not save')
    } catch (e) {
      setErr(String(e))
    }
  }
  return (
    <Section
      title="What counts as a send"
      hint={
        <>
          Connector writes and outbound commands count as sends and wait for your OK. Your exceptions live in <span className="mono">{s?.path ?? 'actions.md'}</span>.
        </>
      }
    >
      {!s ? (
        <Loading />
      ) : (
        <>
          {s.errors.length > 0 && <div className="msg error">The file has problems, so the defaults stand in: {s.errors.join('; ')}</div>}
          <OverrideList title="Not a send" hint="Never held, never in the log. Remove one to count it again." entries={s.notAction} onRemove={(e) => void remove('not_action', e)} />
          <OverrideList title="Always a send" hint="Held for your OK even where Junior wouldn’t count it." entries={s.action} onRemove={(e) => void remove('action', e)} />
          {err && <div className="msg error">{err}</div>}
        </>
      )}
    </Section>
  )
}

function OverrideList({ title, hint, entries, onRemove }: { title: string; hint: string; entries: string[]; onRemove: (entry: string) => void }) {
  return (
    <div className="apGroup">
      <div className="apGroupHead">
        <b>{title}</b> <small>{hint}</small>
      </div>
      {entries.length ? (
        <ul className="apList">
          {entries.map((e) => (
            <li key={e} className="apRow">
              <div className="apMain">
                <span className="mono">{e}</span>
              </div>
              <button type="button" className="btn sm" onClick={() => onRemove(e)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="apEmpty">None.</p>
      )}
    </div>
  )
}

function ApprovalRow({ a, now }: { a: AdvanceApproval; now: number }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const live = isLive(a, now)
  const facts = [
    a.when.kind === 'playbook' ? `only in ${a.when.playbook}` : 'any time',
    a.uses ? `used ${a.uses}×, last ${spanText(now - (a.lastUsedAt ?? now))} ago` : 'not used yet',
    a.revokedAt !== null ? `revoked ${spanText(now - a.revokedAt)} ago` : a.expiresAt !== null ? (live ? `expires in ${spanText(a.expiresAt - now)}` : 'expired') : null,
  ].filter(Boolean)
  async function revoke() {
    setBusy(true)
    setErr(null)
    const r = await revokeApproval(a.id)
    setBusy(false)
    if (!r.ok) setErr(r.error)
  }
  return (
    <li className="apRow">
      <div className="apMain">
        <b>{describeApproval({ ...a, when: { kind: 'any' } })}</b>
        <small>
          <span className="mono">{a.who.id}</span> · {facts.join(' · ')}
        </small>
        {a.why && <small className="apWhy">{a.why}</small>}
        {err && <div className="msg error">{err}</div>}
      </div>
      {live && (
        <button type="button" className="btn sm" disabled={busy} onClick={() => void revoke()}>
          Revoke
        </button>
      )}
    </li>
  )
}

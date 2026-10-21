import { useState } from 'react'
import { type AdvanceApproval, describeApproval, isLive } from '../../../../core/approvals/approvals.js'
import { revokeApproval, useApprovals } from '../../approvals.js'
import { spanText } from '../../actions.js'
import { Loading, Section } from './shared.js'

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
    </>
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

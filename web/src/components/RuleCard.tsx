/**
 * The Rule card: Junior proposes an advance approval (propose_approval) and
 * you add it, or not. Nothing is approved until Add. Once added, the card says
 * so and links to Settings → Approvals, where it can be revoked.
 */
import { ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { type ApprovalWhat, describeApproval, isApprovalWhat, isLive, WHO_KIND } from '../../../core/approvals/approvals.js'
import type { TranscriptItem } from '../transcript.js'
import { addApproval, useApprovals } from '../approvals.js'
import { openSettings } from '../settings.js'

type Proposal = {
  key: string
  toolUseId: string
  what: ApprovalWhat
  who: { id: string; name: string }
  when: { playbook: string; step: string } | null
  why: string
  expiresInDays: number | null
}

const NOT_NOW_KEY = 'triage.ruleCard.notNow'
const readNotNow = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(NOT_NOW_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** The proposals among a run of tool calls: only the ones the server took (a refused one is just a tool error). */
function proposalsIn(tools: readonly TranscriptItem[]): Proposal[] {
  return tools.flatMap((t) => {
    if (t.kind !== 'tool' || !t.id || !t.name.endsWith('__propose_approval') || !t.result || t.result.isError) return []
    const i = t.input as Record<string, unknown>
    const who = (i.who ?? {}) as Record<string, unknown>
    const when = i.when as Record<string, unknown> | undefined
    if (!isApprovalWhat(i.what) || typeof who.id !== 'string' || typeof who.name !== 'string') return []
    return [
      {
        key: t.key,
        toolUseId: t.id,
        what: i.what,
        who: { id: who.id, name: who.name },
        when: when && typeof when.playbook === 'string' && typeof when.step === 'string' ? { playbook: when.playbook, step: when.step } : null,
        why: typeof i.why === 'string' ? i.why : '',
        expiresInDays: typeof i.expiresInDays === 'number' ? i.expiresInDays : null,
      },
    ]
  })
}

export function RuleCards({ sessionId, tools }: { sessionId: string; tools: readonly TranscriptItem[] }) {
  const list = proposalsIn(tools)
  if (!list.length) return null
  return (
    <>
      {list.map((p) => (
        <RuleCard key={p.key} sessionId={sessionId} p={p} />
      ))}
    </>
  )
}

function RuleCard({ sessionId, p }: { sessionId: string; p: Proposal }) {
  const approvals = useApprovals()
  const [notNow, setNotNow] = useState(() => readNotNow().includes(p.toolUseId))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const when = p.when ? ({ kind: 'playbook', ...p.when } as const) : ({ kind: 'any' } as const)
  const line = describeApproval({ what: p.what, who: { kind: WHO_KIND[p.what], ...p.who }, when })
  const added = approvals?.find((a) => a.proposalId === p.toolUseId) ?? null
  const state = !added ? (notNow ? 'dismissed' : 'proposed') : added.revokedAt !== null ? 'revoked' : isLive(added, Date.now()) ? 'added' : 'expired'

  async function add() {
    setBusy(true)
    setErr(null)
    const r = await addApproval({
      what: p.what,
      who: p.who,
      when,
      why: p.why,
      ...(p.expiresInDays ? { expiresAt: Date.now() + p.expiresInDays * 86_400_000 } : {}),
      proposalId: p.toolUseId,
      sessionId,
    })
    setBusy(false)
    if (!r.ok) setErr(r.error)
  }

  function dismiss() {
    const next = [...readNotNow().filter((id) => id !== p.toolUseId), p.toolUseId].slice(-200)
    localStorage.setItem(NOT_NOW_KEY, JSON.stringify(next))
    setNotNow(true)
  }

  return (
    <div className={`ruleCard st-${state}`}>
      <div className="rcHead">
        <ShieldCheck size={14} className="ic" aria-hidden="true" />
        <span className="rcKicker">{state === 'proposed' ? 'Approve in advance?' : 'Advance approval'}</span>
        {state !== 'proposed' && <span className={`pill ${state === 'added' ? 'green' : 'mute'}`}>{state === 'dismissed' ? 'not now' : state}</span>}
      </div>
      <div className="rcLine">{line}</div>
      <dl className="rcFacts">
        <dt>Who</dt>
        <dd>
          {p.who.name} <span className="mono">{p.who.id}</span>
        </dd>
        <dt>When</dt>
        <dd>{p.when ? `only in ${p.when.playbook}, at “${p.when.step}”` : 'any time'}</dd>
        <dt>Until</dt>
        <dd>{p.expiresInDays ? `${p.expiresInDays} day${p.expiresInDays === 1 ? '' : 's'} after you add it` : 'you revoke it'}</dd>
        {p.why && (
          <>
            <dt>Why</dt>
            <dd>{p.why}</dd>
          </>
        )}
      </dl>
      <div className="rcFoot">
        {state === 'proposed' ? (
          <>
            <span className="rcNote">Matching sends go out without a card. Every one shows in Junior’s log.</span>
            <button type="button" className="btn sm" disabled={busy} onClick={dismiss}>
              Not now
            </button>
            <button type="button" className="btn sm primary" disabled={busy} onClick={() => void add()}>
              Add
            </button>
          </>
        ) : state === 'dismissed' ? (
          <button type="button" className="btn sm" onClick={() => setNotNow(false)}>
            Show again
          </button>
        ) : (
          <>
            <span className="rcNote">{state === 'added' ? `Used ${added!.uses} time${added!.uses === 1 ? '' : 's'}.` : 'It covers nothing now.'}</span>
            <button type="button" className="btn sm" onClick={() => openSettings('approvals')}>
              Settings → Approvals
            </button>
          </>
        )}
      </div>
      {err && <div className="astubErr">{err}</div>}
    </div>
  )
}

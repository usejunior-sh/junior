import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { ScoreWeightView } from '../../../../shared/protocol.js'
import { dayOf, scopeOf, setAgo } from '../../../../core/work/corrections.js'
import { clearWeight, useWeights } from '../../weights.js'
import { takeNotebookScroll } from '../../settings.js'
import type { Learning } from '../../../../core/junior/learnings.js'
import { forgetLearning, keepLearning, useLearnings } from '../../learnings.js'
import { latestSource, notebookOrder, scopeText, usedText } from '../../learnings-view.js'
import { LearningEditor, SourceLink } from '../LearnedLine.js'
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
      <Notebook />
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

/** Rows shown in a notebook group before "Show all". */
const NOTEBOOK_SHOWN = 20

/**
 * Junior's notebook: what Junior keeps about how you work, one group per kind,
 * each on the same NotebookRow: Weights (the reason chip's corrections,
 * core/work/weights.ts) and Learned (core/junior/learnings.ts). Suppressions
 * join as a group of their own. No add button: a weight is born from a row's
 * reason, a learning from Junior noticing the same correction twice.
 */
function Notebook() {
  // the reason chip's and the Learned line's link: land on this section, heading focused
  useEffect(() => {
    if (!takeNotebookScroll()) return
    requestAnimationFrame(() => {
      document.getElementById('notebook')?.scrollIntoView({ block: 'start' })
      document.getElementById('notebook-title')?.focus({ preventScroll: true })
    })
  }, [])
  return (
    <Section id="notebook" title="Junior’s notebook" hint="What Junior keeps about how you work. Clear or forget a line and it stops counting.">
      <WeightsGroup />
      <LearnedGroup />
    </Section>
  )
}

/** After a row goes: focus the next row's last button, else the previous one's, else the heading. */
function focusAfterRemove(list: HTMLUListElement | null, n: number) {
  requestAnimationFrame(() => {
    const rows = list?.querySelectorAll<HTMLElement>('.apRow')
    const row = rows?.length ? rows[Math.min(n, rows.length - 1)] : null
    const btns = row?.querySelectorAll<HTMLElement>('.apActs > .btn, .apRow > .btn')
    const to = btns?.length ? btns[btns.length - 1] : document.getElementById('notebook-title')
    to?.focus()
  })
}

function WeightsGroup() {
  const { weights, error } = useWeights()
  const [all, setAll] = useState(false)
  const [rowErr, setRowErr] = useState<{ key: string; error: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const now = Date.now()
  const shown = weights ? (all ? weights : weights.slice(0, NOTEBOOK_SHOWN)) : []
  async function clear(w: ScoreWeightView, n: number) {
    setBusy(w.key)
    setRowErr(null)
    const r = await clearWeight(w.key)
    setBusy(null)
    if (!r.ok) return setRowErr({ key: w.key, error: r.error })
    focusAfterRemove(listRef.current, n)
  }
  return (
    <div className="apGroup">
      <div className="apGroupHead">
        <b>Weights</b> <small>Points you added from a row’s reason. Each lasts 60 days.</small>
      </div>
      {!weights && error ? (
        <div className="msg error" role="alert">
          Couldn’t load the weights. {error}
        </div>
      ) : !weights ? (
        <Loading />
      ) : weights.length ? (
        <>
          <ul className="apList" ref={listRef}>
            {shown.map((w, n) => (
              <NotebookRow
                key={w.key}
                title={w.label}
                mono
                facts={`${scopeOf(w.key)} · set ${setAgo(w.setAt, now)} · counts until ${dayOf(w.expiresAt)}`}
                error={rowErr?.key === w.key ? `Couldn’t clear. ${rowErr.error}` : undefined}
                actions={
                  <button type="button" className="btn sm" disabled={busy === w.key} aria-label={`Clear: ${w.label}`} onClick={() => void clear(w, n)}>
                    Clear
                  </button>
                }
              />
            ))}
          </ul>
          {!all && weights.length > NOTEBOOK_SHOWN && (
            <button type="button" className="btn sm apMore" onClick={() => setAll(true)}>
              Show all {weights.length}
            </button>
          )}
        </>
      ) : (
        <p className="apEmpty">Nothing yet. Open a row’s reason to correct the order.</p>
      )}
    </div>
  )
}

/**
 * Learned: what Junior learned about how you work, with its receipts.
 * Proposed and stale ones wait for Keep or Forget; kept ones load into chats
 * and runs, and can be edited or forgotten.
 */
function LearnedGroup() {
  const { learnings, broken, path, error } = useLearnings()
  const [all, setAll] = useState(false)
  const [rowErr, setRowErr] = useState<{ id: string; error: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const now = Date.now()
  const ordered = learnings ? notebookOrder(learnings) : []
  const shown = all ? ordered : ordered.slice(0, NOTEBOOK_SHOWN)
  async function act(l: Learning, op: 'keep' | 'forget', n: number) {
    setBusy(l.id)
    setRowErr(null)
    const r = op === 'keep' ? await keepLearning(l.id) : await forgetLearning(l.id)
    setBusy(null)
    if (!r.ok) return setRowErr({ id: l.id, error: r.error })
    if (op === 'forget') focusAfterRemove(listRef.current, n)
  }
  return (
    <div className="apGroup">
      <div className="apGroupHead">
        <b>Learned</b> <small>Facts Junior uses in chats and runs.</small>
      </div>
      {broken.length > 0 && (
        <div className="msg error">
          {broken.length} {broken.length === 1 ? 'file' : 'files'} in <span className="mono">{path}</span> didn’t parse.
        </div>
      )}
      {!learnings && error ? (
        <div className="msg error" role="alert">
          Couldn’t load what Junior learned. {error}
        </div>
      ) : !learnings ? (
        <Loading />
      ) : ordered.length ? (
        <>
          <ul className="apList" ref={listRef}>
            {shown.map((l, n) =>
              editing === l.id ? (
                <li key={l.id} className="apRow">
                  <div className="apMain">
                    <LearningEditor learning={l} label={`Edit: ${l.text}`} onDone={() => setEditing(null)} />
                  </div>
                </li>
              ) : (
                <NotebookRow
                  key={l.id}
                  title={l.text}
                  pill={l.status === 'proposed' ? <span className="pill mute">proposed</span> : l.status === 'stale' ? <span className="pill yellow">stale</span> : undefined}
                  facts={<LearnedFacts l={l} now={now} />}
                  error={rowErr?.id === l.id ? `Couldn’t save. ${rowErr.error}` : undefined}
                  actions={
                    <span className="apActs">
                      {l.status === 'kept' ? (
                        <button type="button" className="btn sm" disabled={busy === l.id} aria-label={`Edit: ${l.text}`} onClick={() => setEditing(l.id)}>
                          Edit
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn sm primary"
                          disabled={busy === l.id}
                          aria-busy={busy === l.id || undefined}
                          aria-label={`Keep: ${l.text}`}
                          onClick={() => void act(l, 'keep', n)}
                        >
                          Keep
                        </button>
                      )}
                      <button type="button" className="btn sm" disabled={busy === l.id} aria-label={`Forget: ${l.text}`} onClick={() => void act(l, 'forget', n)}>
                        Forget
                      </button>
                    </span>
                  }
                />
              ),
            )}
          </ul>
          {!all && ordered.length > NOTEBOOK_SHOWN && (
            <button type="button" className="btn sm apMore" onClick={() => setAll(true)}>
              Show all {ordered.length}
            </button>
          )}
        </>
      ) : (
        <p className="apEmpty">Nothing yet. Junior proposes one when you correct it the same way twice.</p>
      )}
    </div>
  )
}

/** "acme/web · from PR #3235 +1 more · used yesterday", and for a stale one, why. */
function LearnedFacts({ l, now }: { l: Learning; now: number }) {
  const ref = latestSource(l)
  const more = l.sources.length - 1
  return (
    <>
      <span className={l.scope === 'global' ? undefined : 'mono'}>{scopeText(l.scope)}</span>
      {ref && (
        <>
          {' · from '}
          <SourceLink sourceRef={ref} />
          {more > 0 && ` +${more} more`}
        </>
      )}
      {` · ${usedText(l, now)}`}
      {l.status === 'stale' && ' · its receipts are gone'}
    </>
  )
}

/** One line in Junior's notebook: what it is, its facts, its buttons. Every kind of entry uses it. */
function NotebookRow({
  title,
  mono,
  pill,
  facts,
  actions,
  error,
}: {
  title: string
  mono?: boolean
  pill?: ReactNode
  facts: ReactNode
  actions: ReactNode
  error?: string
}) {
  return (
    <li className="apRow">
      <div className="apMain">
        <span className="apTitle">
          <b className={mono ? 'mono' : undefined}>{title}</b>
          {pill}
        </span>
        <small>{facts}</small>
        {error && (
          <div className="msg error" role="alert">
            {error}
          </div>
        )}
      </div>
      {actions}
    </li>
  )
}

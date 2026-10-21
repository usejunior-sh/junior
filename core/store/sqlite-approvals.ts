import { DatabaseSync } from 'node:sqlite'
import type { ApprovalStore } from './types.js'
import { type AdvanceApproval, type ApprovalWhen, isApprovalWhat, WHO_KIND } from '../approvals/approvals.js'

type ApprovalRow = {
  id: string
  what: string
  who_kind: string
  who_id: string
  who_name: string
  when_json: string
  why: string
  created_at: number
  expires_at: number | null
  revoked_at: number | null
  session_id: string | null
  proposal_id: string | null
  uses: number
  last_used_at: number | null
}

function whenOf(json: string): ApprovalWhen {
  try {
    const w = JSON.parse(json) as Record<string, unknown>
    if (w.kind === 'playbook' && typeof w.playbook === 'string' && typeof w.step === 'string') return { kind: 'playbook', playbook: w.playbook, step: w.step }
  } catch {}
  return { kind: 'any' }
}

/** A row → an approval; one whose kind this build doesn't know is dropped (it can match nothing). */
function toApproval(r: ApprovalRow): AdvanceApproval | null {
  if (!isApprovalWhat(r.what)) return null
  return {
    id: r.id,
    what: r.what,
    who: { kind: WHO_KIND[r.what], id: r.who_id, name: r.who_name },
    when: whenOf(r.when_json),
    why: r.why,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    sessionId: r.session_id,
    proposalId: r.proposal_id,
    uses: r.uses,
    lastUsedAt: r.last_used_at,
  }
}

const COLS = 'id, what, who_kind, who_id, who_name, when_json, why, created_at, expires_at, revoked_at, session_id, proposal_id, uses, last_used_at'

export class SqliteApprovals implements ApprovalStore {
  constructor(private db: DatabaseSync) {}

  async list(): Promise<AdvanceApproval[]> {
    const rows = this.db.prepare(`SELECT ${COLS} FROM approvals ORDER BY created_at DESC`).all() as ApprovalRow[]
    return rows.map(toApproval).filter((a): a is AdvanceApproval => !!a)
  }

  async get(id: string): Promise<AdvanceApproval | null> {
    const r = this.db.prepare(`SELECT ${COLS} FROM approvals WHERE id = ?`).get(id) as ApprovalRow | undefined
    return r ? toApproval(r) : null
  }

  async byProposal(proposalId: string): Promise<AdvanceApproval | null> {
    const r = this.db.prepare(`SELECT ${COLS} FROM approvals WHERE proposal_id = ?`).get(proposalId) as ApprovalRow | undefined
    return r ? toApproval(r) : null
  }

  async put(a: AdvanceApproval): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO approvals (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET what = excluded.what, who_kind = excluded.who_kind, who_id = excluded.who_id, who_name = excluded.who_name,
           when_json = excluded.when_json, why = excluded.why, expires_at = excluded.expires_at, revoked_at = excluded.revoked_at,
           uses = excluded.uses, last_used_at = excluded.last_used_at`,
      )
      .run(a.id, a.what, a.who.kind, a.who.id, a.who.name, JSON.stringify(a.when), a.why, a.createdAt, a.expiresAt, a.revokedAt, a.sessionId, a.proposalId, a.uses, a.lastUsedAt)
  }

  async revoke(id: string, at: number): Promise<boolean> {
    return this.db.prepare('UPDATE approvals SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(at, id).changes > 0
  }

  async used(id: string, at: number): Promise<void> {
    this.db.prepare('UPDATE approvals SET uses = uses + 1, last_used_at = ? WHERE id = ?').run(at, id)
  }
}

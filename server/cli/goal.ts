import { goalFlags } from './args.js'
import { bold, cyan, die, dim, green, yellow } from './ui.js'
import { type WireWorkspace, serverPort } from './workspace.js'

// Goals live in the running server's database, so these always go over its
// HTTP API (server/goals.ts): there is no offline fallback.

type WireGoal = {
  id: string
  title: string
  state: string
  turn: string
  horizon: string
  updatedAt: number
  doneWhen?: string
  reason?: string | null
  sourceItemId?: string | null
  budget?: { usd: number | null; minutes: number | null }
  spentUsd?: number
}

const TURN_WORD: Record<string, string> = { me: 'you', ai: 'Junior', others: 'the world', none: '—' }

function ago(at: number): string {
  const m = Math.round((Date.now() - at) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`
  return `${Math.round(m / 1440)}d ago`
}

export async function goalCmd(sub: string | undefined, rest: string[]) {
  const port = await serverPort()
  if (!port) die(`goals need the server running — start it with ${cyan('triage')}`)
  const ws = goalFlags.workspace ? `workspace=${encodeURIComponent(goalFlags.workspace)}` : ''
  const call = async <T>(p: string, body?: unknown): Promise<T> => {
    const url = `http://localhost:${port}${p}${ws ? (p.includes('?') ? '&' : '?') + ws : ''}`
    const res = await fetch(url, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const out = (await res.json()) as T & { ok: boolean; error?: string }
    if (!out.ok) die(out.error ?? `${p} failed`)
    return out
  }

  if (sub === 'list' || sub === undefined) {
    const q = goalFlags.state ? `?states=${encodeURIComponent(goalFlags.state)}` : ''
    const body = await call<{ goals: WireGoal[]; waitingOnYou: number }>(`/api/goals${q}`)
    if (!body.goals.length) {
      console.log(dim(`no goals — start one with ${cyan('triage goal create <title> --done-when <text>')}`))
      return
    }
    const w = Math.max(...body.goals.map((g) => g.state.length))
    for (const g of body.goals) {
      const state = g.turn === 'me' ? yellow(g.state.padEnd(w)) : g.state.padEnd(w)
      console.log(`${state}  ${bold(g.title)}  ${dim(`${TURN_WORD[g.turn] ?? g.turn} · ${ago(g.updatedAt)} · ${g.id}`)}`)
    }
    if (body.waitingOnYou) console.log(`\n${yellow(String(body.waitingOnYou))} waiting on you`)
    return
  }

  if (sub === 'create') {
    const title = rest.join(' ').trim()
    if (!title || !goalFlags.doneWhen) die(`goal create needs a title and --done-when, e.g. ${cyan('triage goal create "Ship the fix" --done-when "PR #12 is merged"')}`)
    const body = await call<{ goal: WireGoal; outcome: string }>('/api/goals', {
      title,
      doneWhen: goalFlags.doneWhen,
      ...(goalFlags.horizon ? { horizon: goalFlags.horizon } : {}),
    })
    const verb = body.outcome === 'created' ? 'created' : 'already have'
    console.log(`${green('✓')} ${verb} goal ${bold(body.goal.title)} ${dim(`(${body.goal.id} · ${body.goal.state})`)}`)
    return
  }

  if (sub === 'show') {
    const id = rest[0]
    if (!id) die(`goal show needs an id — see ${cyan('triage goal list')}`)
    const body = await call<{ goal: WireGoal; turn: string; plan: string; handoff: string; log: string; ledgerWarning: string | null }>(`/api/goals/${encodeURIComponent(id)}`)
    const g = body.goal
    const budget = [g.budget?.usd != null ? `$${g.budget.usd}` : null, g.budget?.minutes != null ? `${g.budget.minutes} min` : null].filter(Boolean).join(' · ') || 'no cap'
    console.log(bold(g.title))
    console.log(`  ${dim('state')}      ${g.state}${g.reason ? dim(` — ${g.reason}`) : ''}`)
    console.log(`  ${dim('turn')}       ${TURN_WORD[body.turn] ?? body.turn}`)
    console.log(`  ${dim('done when')}  ${g.doneWhen}`)
    console.log(`  ${dim('horizon')}    ${g.horizon}`)
    console.log(`  ${dim('budget')}     ${budget} ${dim(`($${(g.spentUsd ?? 0).toFixed(2)} spent)`)}`)
    if (g.sourceItemId) console.log(`  ${dim('from')}       ${g.sourceItemId}`)
    console.log(`  ${dim('updated')}    ${ago(g.updatedAt)}`)
    if (body.ledgerWarning) console.log(`\n${yellow('!')} ${body.ledgerWarning}`)
    for (const [name, text] of [['plan.md', body.plan], ['handoff.md', body.handoff], ['log.md', body.log]] as const)
      console.log(`\n${cyan(`── ${name} `)}\n${text.trim() || dim('(not written yet)')}`)
    return
  }

  die(`unknown goal command "${sub}" — try ${cyan('triage goal list')}`)
}

/**
 * `triage add "…"`, a one-line hand-off without opening the app: a manual
 * item through the same route the inbox's own add uses (createManualOp).
 */
export async function addCmd(rest: string[]) {
  const title = rest.join(' ').trim()
  if (!title) die(`add needs a title, e.g. ${cyan('triage add "Look at the flaky deploy check"')}`)
  const port = await serverPort()
  if (!port) die(`add needs the server running — start it with ${cyan('triage')}`)
  // The HTTP API falls back to the default workspace for an id it doesn't
  // know, so a typo would file the item somewhere else, resolve it first.
  let ws = ''
  if (goalFlags.workspace) {
    const ref = goalFlags.workspace
    const { workspaces } = (await (await fetch(`http://localhost:${port}/api/workspaces`)).json()) as { workspaces: WireWorkspace[] }
    const match = workspaces.find((w) => w.id === ref || w.name.toLowerCase() === ref.toLowerCase())
    if (!match) die(`no workspace named "${ref}" — see ${cyan('triage workspace list')}`)
    ws = `?workspace=${encodeURIComponent(match.id)}`
  }
  const res = await fetch(`http://localhost:${port}/api/items/manual${ws}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  const out = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as { ok: boolean; id?: string; error?: string }
  if (!out.ok) die(out.error ?? 'add failed')
  console.log(`${green('✓')} added ${bold(title)}${out.id ? ' ' + dim(`(${out.id})`) : ''}`)
}

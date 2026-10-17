import { useState, useEffect } from 'react'
import type { SessionTeamRun, TeamRunView, TeamRun, TeamCard } from '../../../../shared/protocol.js'
import { normalizeRun } from '../../../../core/teams/engine.js'
import { teamsCall, loadTeamRun, colorOf } from '../../teams.js'

/**
 * A team run in a session (Teams v2), in three places so none of them is big:
 *
 *   TeamStrip  over the transcript, who's on the team, what each is doing and has spent
 *   TeamDock   above the composer, on the lead, the one thing the run needs from you now
 *   TeamSide   a drawer on the right. Every detail, editable in place before you approve
 *
 * All three read one fetch of the run (useTeamRun), refetched whenever its revision moves.
 */

export const call = (path: string, body: unknown) => teamsCall<{ ok: true }>('POST', path, body)
export const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function useTeamRun(link: SessionTeamRun | undefined): TeamRunView | null {
  const [run, setRun] = useState<TeamRunView | null>(null)
  useEffect(() => {
    if (!link) {
      setRun(null)
      return
    }
    let live = true
    loadTeamRun(link.id)
      // A server from before plans and tasks sends runs without them: fill today's empty defaults.
      .then((r) => live && setRun(normalizeRun(r as unknown as TeamRun) as unknown as TeamRunView))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [link?.id, link?.rev, link?.state]) // eslint-disable-line react-hooks/exhaustive-deps
  return run && link && run.id === link.id ? run : null
}

/** The card as the server takes it back (PUT /api/teams/card). */
export const wireCard = (c: TeamCard) => ({
  goal: c.goal,
  criteria: c.criteria,
  outOfScope: c.outOfScope,
  tasks: c.tasks,
  decisions: c.decisions,
  budgetUsd: c.budgetUsd,
  permissions: c.permissions ?? undefined,
  fast: c.fast,
  note: c.note,
  steps: c.steps.map((s) => ({ id: s.id, model: s.model ?? undefined, slices: s.slices ?? undefined })),
})

/** One step's agent, as the team reads it. */
export function who(run: TeamRunView, agent: string): { label: string; color: string } {
  if (agent === 'lead') return { label: 'Lead', color: 'lead' }
  if (agent === 'checks') return { label: 'checks', color: 'checks' }
  const a = run.agents.find((x) => x.name === agent)
  return { label: a?.label ?? agent, color: a?.color ?? 'blue' }
}

export function Mark({ color }: { color: string }) {
  if (color === 'lead') return <span className="mgrGlyph" aria-hidden="true" />
  if (color === 'checks') return <span className="swatch sys" aria-hidden="true" />
  return <span className="swatch" style={{ background: colorOf(color) }} aria-hidden="true" />
}

/** How many workers a step has, or will have: "×3", "×≤4", or nothing for one. */
export function widthOf(run: TeamRunView, i: number): string {
  const s = run.recipe.steps[i]
  if (!s.fanOut) return ''
  const started = run.workers.filter((w) => w.stepId === s.id).length
  if (started > 1) return `×${started}`
  const planned = run.card.steps.find((c) => c.id === s.id)?.slices?.length
  return planned ? `×${planned}` : `×≤${s.fanOut.max}`
}

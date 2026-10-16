import { ArrowRight, FolderOpen } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { LibraryStatus, RecipeEntry, TeamLibraryResponse } from '../../../shared/protocol.js'
import { setSettingsTab } from '../settings.js'
import { blockFromRecipe } from '../../../core/goals/blocks.js'
import { loadTeamLibrary, teamsCall, type TeamLibrary } from '../teams.js'

const STATUS: Record<LibraryStatus, { label: string; title: string }> = {
  default: { label: 'default', title: 'Exactly as triage ships it' },
  edited: { label: 'edited', title: 'A triage default you changed — Reset puts it back' },
  update: { label: 'newer default', title: 'You edited this, and triage has since shipped a newer default — Reset to take it (your edits are lost)' },
  yours: { label: 'yours', title: 'Made by you — triage never touches it' },
}

const asLib = (b: TeamLibraryResponse): TeamLibrary => {
  if (!b.ok) throw new Error(b.error)
  return { teams: b.teams, agents: b.agents, dir: b.dir }
}

const openFolder = () => void teamsCall('POST', 'open').catch(() => {})

/**
 * Settings → Teams: the workspace's teams, read as workflow blocks (M6). A team
 * is still a recipe file (server/teams.ts), edited as its file; a goal's plan
 * uses one as a step, expanded into the steps shown here (core/goals/blocks.ts).
 * The agents a team is made of are edited under Settings → Agents.
 */
export function TeamsTab() {
  const [lib, setLib] = useState<TeamLibrary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)

  const load = useCallback(() => {
    loadTeamLibrary()
      .then(setLib)
      .catch((err) => setError(String(err)))
  }, [])
  useEffect(load, [load])

  const act = async (fn: () => Promise<TeamLibraryResponse>) => {
    setError(null)
    try {
      setLib(asLib(await fn()))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const reset = (name: string) => act(() => teamsCall('POST', 'reset', { kind: 'team', name }))
  const remove = (name: string) => {
    setConfirm(null)
    return act(() => teamsCall('DELETE', `team?name=${encodeURIComponent(name)}`))
  }

  return (
    <section className="setSection teamsTab">
      <div className="teamsTabBar">
        <span className="teamsTabCount">{lib ? `${lib.teams.length} workflow block${lib.teams.length === 1 ? '' : 's'}` : ''}</span>
        <span className="sp" />
        <button type="button" className="btn sm ghost" onClick={openFolder} title={lib?.dir}>
          <FolderOpen size={12} aria-hidden="true" /> Open folder
        </button>
        <button type="button" className="btn sm" onClick={() => setSettingsTab('agents')} title="Team agents are edited under Agents">
          Agents{lib ? ` · ${lib.agents.length}` : ''} <ArrowRight size={12} aria-hidden="true" />
        </button>
      </div>

      {error && <div className="msg error">{error}</div>}
      {!lib && !error && <div className="pickerLoading">Loading…</div>}

      {lib &&
        (lib.teams.length === 0 ? (
          <div className="projEmpty">No workflow blocks — add a recipe file to the teams folder, or delete its .seeded.json to get the defaults back.</div>
        ) : (
          <div className="libList">
            {lib.teams.map((t) => (
              <TeamRow
                key={t.name}
                team={t}
                confirming={confirm === `team:${t.name}`}
                onReset={() => void reset(t.name)}
                onDelete={() => setConfirm(`team:${t.name}`)}
                onConfirm={() => void remove(t.name)}
                onCancel={() => setConfirm(null)}
              />
            ))}
          </div>
        ))}
      <div className="libHint">
        Workflow blocks are the recipe files in <span className="mono">teams/</span> — edit one in your editor. A goal's plan uses one as a step (<span className="mono">type: block</span>), expanded into the steps above
        when the plan is read; fan-out, task loops and per-step models stay with the old team runs.
      </div>
    </section>
  )
}

function Status({ s }: { s: LibraryStatus }) {
  return (
    <span className={`libStatus ${s}`} title={STATUS[s].title}>
      {STATUS[s].label}
    </span>
  )
}

function RowActions({
  status,
  confirming,
  confirmText,
  onOpen,
  onReset,
  onDelete,
  onConfirm,
  onCancel,
}: {
  status: LibraryStatus
  confirming: boolean
  confirmText: string
  onOpen?: () => void
  onReset: () => void
  onDelete: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  if (confirming)
    return (
      <span className="libActs confirm">
        <span className="libConfirmText">{confirmText}</span>
        <button type="button" className="btn sm danger" onClick={onConfirm}>
          Delete
        </button>
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
      </span>
    )
  return (
    <span className="libActs">
      {onOpen && (
        <button type="button" className="btn sm ghost" onClick={onOpen} title="Teams are edited as files — opens the teams folder">
          Open file
        </button>
      )}
      {(status === 'edited' || status === 'update') && (
        <button type="button" className="btn sm ghost" onClick={onReset} title="Put back exactly what triage ships">
          Reset
        </button>
      )}
      <button type="button" className="btn sm ghost" onClick={onDelete}>
        Delete
      </button>
    </span>
  )
}

function TeamRow({
  team,
  confirming,
  ...acts
}: {
  team: RecipeEntry
  confirming: boolean
  onReset: () => void
  onDelete: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const r = team.recipe
  const b = r ? blockFromRecipe(team.name, r) : null
  const file = `teams/${team.name}.md`
  return (
    <div className="libRow team">
      <span className="libName" title={r?.description || file}>
        {r ? r.label : <span className="mono">{team.name}</span>}
      </span>
      {b ? (
        <span className="libSteps">
          <span className="libStepLine mono" title={b.steps.map((s) => `${s.id}: ${s.role ?? 'you'} — ${s.doneWhen}`).join('\n')}>
            {b.steps.map((s, i) => (
              <span key={s.id}>
                {i > 0 && <span className="arrow"> → </span>}
                {s.type === 'gate' ? <span className="gate">you approve</span> : `${s.id} · ${s.role}`}
              </span>
            ))}
          </span>
          {team.missing.length > 0 && (
            <span className="libMissing" title={`No agent file for: ${team.missing.join(', ')}`}>
              missing {team.missing.join(', ')}
            </span>
          )}
        </span>
      ) : (
        <span className="libSteps">
          <span className="libErr" title={team.errors.length > 1 ? team.errors.join('\n') : undefined}>
            {team.errors[0] ?? 'this file is not a valid recipe'}
            {team.errors.length > 1 && <span className="more"> +{team.errors.length - 1}</span>}
          </span>
        </span>
      )}
      <span className="libBudget mono" title={b ? 'The steps it adds to a goal plan' : undefined}>
        {b ? `${b.steps.length} steps` : ''}
      </span>
      <Status s={team.status} />
      <RowActions status={team.status} confirming={confirming} confirmText={`Delete ${r?.label ?? team.name}?`} onOpen={openFolder} {...acts} />
    </div>
  )
}

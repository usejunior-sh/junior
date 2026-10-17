import { ArrowLeft, Sparkles } from 'lucide-react'
import { useState } from 'react'
import type { LibraryKind, LibraryTarget } from '../../../../shared/protocol.js'
import { slugName } from '../../../../shared/skillFile.js'
import { createLibraryEntry, askClaude, createPrompt, targetCwd } from '../../library.js'
import { Select, SelectItem } from '../../ui/Select.js'
import { Field, SOURCE_HINT } from './fields.js'

// New: a template now, or a session that writes it with you

const TEAM_TARGET = 'team'

export function NewForm({
  kind,
  targets,
  onTeamAgent,
  onCancel,
  onCreated,
}: {
  kind: LibraryKind
  targets: LibraryTarget[]
  /** agents only: hand over to the team-agent form */
  onTeamAgent?: () => void
  onCancel: () => void
  onCreated: (path: string) => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [target, setTarget] = useState(targets[0]?.id ?? 'workspace')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const slug = slugName(name)
  const t = targets.find((x) => x.id === target)
  const noun = kind === 'skill' ? 'skill' : 'agent'

  async function create() {
    setBusy(true)
    setError(null)
    try {
      onCreated((await createLibraryEntry({ kind, target, name: slug, description })).path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="lbEditor">
      <header className="lbHead">
        <button type="button" className="iconBtn" aria-label="Back" title="Back" onClick={onCancel}>
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <div className="lbHeadT">
          <div className="lbHeadName">New {noun}</div>
          <div className="lbHeadSub">Start from a short template, or describe it and let Claude write it with you.</div>
        </div>
      </header>
      <div className="lbBody">
        <div className="lbFields">
          <Field label="Name" hint={slug && t ? (kind === 'skill' ? `${t.dir}/skills/${slug}/SKILL.md` : `${t.dir}/agents/${slug}.md`) : 'lowercase-with-dashes — how you call it'}>
            <input className="teamInp wide" value={name} autoFocus placeholder={kind === 'skill' ? 'e.g. release-notes' : 'e.g. code-critic'} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label={kind === 'skill' ? 'What it does' : 'When to use it'} hint="Becomes the description — Claude reads it to decide when to reach for this.">
            <textarea
              className="teamArea lbArea"
              rows={3}
              value={description}
              placeholder={kind === 'skill' ? 'Drafts release notes from the commits since the last tag. Use when asked to write release notes.' : 'Reviews a diff for bugs and risky changes. Use after finishing a change.'}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field
            label="Where"
            hint={target === TEAM_TARGET ? SOURCE_HINT.team(kind) : t ? SOURCE_HINT[t.id === 'workspace' ? 'workspace' : t.id === 'personal' ? 'personal' : 'project'](kind) : undefined}
          >
            <Select className="teamSel" aria-label="Where" value={target} onValueChange={setTarget}>
              {targets.map((x) => (
                <SelectItem key={x.id} value={x.id} description={x.dir}>
                  {x.id.startsWith('project:') ? `Project · ${x.label}` : x.label}
                </SelectItem>
              ))}
              {onTeamAgent && (
                <SelectItem value={TEAM_TARGET} description="A team run's cast — not a chat subagent">
                  Teams
                </SelectItem>
              )}
            </Select>
          </Field>
        </div>
      </div>
      <footer className="lbFoot">
        {error && <span className="lbErr">{error}</span>}
        <span className="sp" />
        {target === TEAM_TARGET && onTeamAgent ? (
          <button type="button" className="btn primary" onClick={onTeamAgent}>
            Continue to the team form
          </button>
        ) : (
          <>
        <button
          type="button"
          className="btn"
          disabled={!t}
          title="Opens a new session with the request written — Claude asks what it needs, then writes the file"
          onClick={() => t && askClaude(`New ${noun}${slug ? `: ${slug}` : ''}`, createPrompt(kind, t, slug, description), targetCwd(t))}
        >
          <Sparkles size={12} aria-hidden="true" /> Create with Claude
        </button>
        <button type="button" className="btn primary" disabled={busy || !slug} onClick={() => void create()}>
          {busy ? 'Creating…' : `Create ${noun}`}
        </button>
          </>
        )}
      </footer>
    </div>
  )
}

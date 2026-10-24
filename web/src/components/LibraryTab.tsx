/**
 * Settings → Skills and Settings → Agents: every Claude Code skill or subagent a
 * session here can see, in one browsable list with an editor beside it.
 *
 *   left   search, source pills with counts, the list grouped by where each
 *          one lives (workspace · personal · each project · each plugin)
 *   right  the selected file: name and description as fields (plus model,
 *          tools and colour for an agent), the instructions with a preview,
 *          or the raw file; a skill's other files one click away
 *
 * Fields edit the frontmatter surgically (shared/skillFile.ts), so keys the
 * form doesn't show survive. Saving reloads every open session (server). The
 * Agents tab also lists the workspace's team agents and edits them with the
 * team form. They are a team run's cast, not a chat's subagents.
 */
import { Search, X, Plus, Lock } from 'lucide-react'
import { type ReactNode, useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { type LibrarySource, type LibraryEntry, type AgentEntry, type LibraryKind, AGENT_COLORS } from '../../../shared/protocol.js'
import { useLibrary } from '../library.js'
import { type TeamLibrary, loadTeamLibrary, AGENT_HEX, canSummary } from '../teams.js'
import { EntryEditor, TeamAgentEditor } from './library/EntryEditor.js'
import { type Filter, SOURCE_HINT, SOURCE_LABEL } from './library/fields.js'
import { NewForm } from './library/NewForm.js'
import { ConfirmDialog } from '../ui/ConfirmDialog.js'

/** What the list's left column holds: a library file or a team agent. */
type Row = { key: string; group: string; source: LibrarySource | 'team'; name: string; description: string; meta: ReactNode; entry?: LibraryEntry; team?: AgentEntry }

/** null = nothing open; 'new' = the create form; 'new-team' = a new team agent; otherwise a row key. */
type Selection = null | 'new' | 'new-team' | string

const SHOW_TEAMS = false

export function LibraryTab({ kind, refreshNonce }: { kind: LibraryKind; refreshNonce: number }) {
  const { list, error, reload } = useLibrary(kind, refreshNonce)
  const [teams, setTeams] = useState<TeamLibrary | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<Selection>(null)
  // The editor reports unsaved edits up, so leaving it can ask first.
  const dirtyRef = useRef(false)
  // Where the user asked to go while the editor had unsaved edits; set = the discard confirm is up.
  const [pending, setPending] = useState<{ to: Selection } | null>(null)

  // Team agents are not listed while the teams UI is hidden (the engine and its files stay).
  const loadTeams = useCallback(() => {
    if (kind === 'agent' && SHOW_TEAMS) loadTeamLibrary().then(setTeams).catch(() => setTeams(null))
  }, [kind])
  useEffect(loadTeams, [loadTeams, refreshNonce])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = (list?.entries ?? []).map((e) => ({
      key: e.path,
      group: e.source === 'workspace' ? 'Workspace' : e.source === 'personal' ? 'Personal' : e.source === 'plugin' ? `${e.scope} · plugin` : `${e.scope} · project`,
      source: e.source,
      name: e.name,
      description: e.description,
      entry: e,
      meta: <EntryMeta e={e} />,
    }))
    for (const a of teams?.agents ?? []) {
      out.push({
        key: `team:${a.name}`,
        group: 'Teams',
        source: 'team',
        name: a.name,
        description: a.description,
        team: a,
        meta: (
          <>
            <span className="lbSwatch" style={{ background: AGENT_HEX[a.color] }} aria-hidden="true" />
            <span className="lbChip" title={canSummary(a.can)}>
              {a.model ?? 'default'}
            </span>
          </>
        ),
      })
    }
    return out
  }, [list, teams])

  const counts = useMemo(() => {
    const c: Partial<Record<Filter, number>> = { all: rows.length }
    for (const r of rows) c[r.source] = (c[r.source] ?? 0) + 1
    return c
  }, [rows])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter(
      (r) => (filter === 'all' || r.source === filter) && (!q || `${r.name} ${r.description} ${r.group}`.toLowerCase().includes(q)),
    )
  }, [rows, filter, query])

  const groups = useMemo(() => {
    const m = new Map<string, Row[]>()
    for (const r of shown) m.set(r.group, [...(m.get(r.group) ?? []), r])
    return [...m.entries()]
  }, [shown])

  const select = (s: Selection) => {
    if (s === selected) return
    if (dirtyRef.current) {
      setPending({ to: s })
      return
    }
    dirtyRef.current = false
    setSelected(s)
  }
  const discardAndGo = () => {
    if (!pending) return
    dirtyRef.current = false
    setSelected(pending.to)
  }

  const current = selected && selected !== 'new' && selected !== 'new-team' ? rows.find((r) => r.key === selected) : undefined
  const filters: Filter[] = ['all', 'workspace', 'personal', 'project', 'plugin', ...(kind === 'agent' && SHOW_TEAMS ? (['team'] as const) : [])]
  const noun = kind === 'skill' ? 'skill' : 'agent'

  return (
    <div className={`lb${selected ? ' picked' : ''}`}>
      <aside className="lbSide">
        <div className="lbSearch">
          <Search size={13} aria-hidden="true" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${noun}s`} aria-label={`Search ${noun}s`} />
          {query && (
            <button type="button" className="iconBtn" aria-label="Clear search" onClick={() => setQuery('')}>
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="lbPills" role="tablist" aria-label="Where they come from">
          {filters.map((f) => (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={`lbPill${filter === f ? ' on' : ''}`}
              onClick={() => setFilter(f)}
              disabled={f !== 'all' && f !== 'workspace' && !counts[f]}
            >
              {SOURCE_LABEL[f]} <span className="n">{counts[f] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="lbList">
          {error && <div className="msg error">{error}</div>}
          {!list && !error && <div className="pickerLoading">Loading…</div>}
          {list && groups.length === 0 && (
            <div className="lbNone">{query ? `No ${noun}s match “${query}”.` : filter === 'workspace' ? `No workspace ${noun}s yet.` : `No ${noun}s here.`}</div>
          )}
          {groups.map(([group, items]) => (
            <section key={group} className="lbGroup">
              <header className="lbGroupHead" title={SOURCE_HINT[items[0].source](kind)}>
                <span className="t">{group}</span>
                <span className="n">{items.length}</span>
              </header>
              {items.map((r) => (
                <button key={r.key} type="button" className={`lbItem${selected === r.key ? ' on' : ''}`} onClick={() => select(r.key)}>
                  <span className="lbItemTop">
                    <span className="lbItemName">{r.name}</span>
                    <span className="lbItemMeta">{r.meta}</span>
                  </span>
                  {r.description && <span className="lbItemDesc">{r.description}</span>}
                </button>
              ))}
            </section>
          ))}
        </div>
        <div className="lbSideFoot">
          <button type="button" className={`btn sm${selected === 'new' ? ' primary' : ''}`} onClick={() => select('new')}>
            <Plus size={12} aria-hidden="true" /> New {noun}
          </button>
        </div>
      </aside>

      <section className="lbMain">
        {selected === 'new' && list ? (
          <NewForm
            kind={kind}
            targets={list.targets}
            onTeamAgent={teams ? () => setSelected('new-team') : undefined}
            onCancel={() => select(null)}
            onCreated={(p) => {
              reload()
              dirtyRef.current = false
              setSelected(p)
            }}
          />
        ) : current?.entry ? (
          <EntryEditor
            key={current.key}
            entry={current.entry}
            onBack={() => select(null)}
            onDirty={(d) => (dirtyRef.current = d)}
            onDeleted={() => {
              dirtyRef.current = false
              setSelected(null)
              reload()
            }}
          />
        ) : selected === 'new-team' && teams ? (
          <TeamAgentEditor
            key="new-team"
            entry={null}
            onBack={() => select(null)}
            taken={teams.agents}
            onDirty={(d) => (dirtyRef.current = d)}
            onSaved={(l, name) => {
              dirtyRef.current = false
              setTeams(l)
              setSelected(`team:${name}`)
            }}
          />
        ) : current?.team && teams ? (
          <TeamAgentEditor
            key={current.key}
            entry={current.team}
            onBack={() => select(null)}
            taken={teams.agents}
            onDirty={(d) => (dirtyRef.current = d)}
            onSaved={(l) => {
              dirtyRef.current = false
              setTeams(l)
            }}
          />
        ) : (
          <Empty kind={kind} counts={counts} onNew={() => select('new')} />
        )}
      </section>
      <ConfirmDialog
        open={pending !== null}
        title="Discard unsaved changes?"
        body="Your edits aren't saved."
        confirm="Discard"
        danger
        onConfirm={discardAndGo}
        onClose={() => setPending(null)}
      />
    </div>
  )
}

function EntryMeta({ e }: { e: LibraryEntry }) {
  return (
    <>
      {e.kind === 'agent' && e.color && (AGENT_COLORS as readonly string[]).includes(e.color) && (
        <span className="lbSwatch" style={{ background: AGENT_HEX[e.color as keyof typeof AGENT_HEX] }} aria-hidden="true" />
      )}
      {e.kind === 'agent' && e.model && <span className="lbChip">{e.model}</span>}
      {e.kind === 'skill' && !!e.files && (
        <span className="lbChip" title={`${e.files} more file${e.files === 1 ? '' : 's'} beside SKILL.md`}>
          +{e.files}
        </span>
      )}
      {!e.editable && <Lock size={11} className="lbLock" aria-label="read-only" />}
    </>
  )
}

function Empty({ kind, counts, onNew }: { kind: LibraryKind; counts: Partial<Record<Filter, number>>; onNew: () => void }) {
  const noun = kind === 'skill' ? 'skill' : 'agent'
  return (
    <div className="lbEmpty">
      <div className="lbEmptyN">{counts.all ?? 0}</div>
      <div className="lbEmptyT">
        {noun}s a session here can {kind === 'skill' ? 'use' : 'hand work to'}
      </div>
      <p>
        Pick one to read or edit it. Saving reloads every open session, so a change is live on the next message — no restart.
        {kind === 'skill' ? ' Type / in a chat to use one.' : ' Claude picks an agent by its description.'}
      </p>
      <button type="button" className="btn sm" onClick={onNew}>
        <Plus size={12} aria-hidden="true" /> New {noun}
      </button>
    </div>
  )
}

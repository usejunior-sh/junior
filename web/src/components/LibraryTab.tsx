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
 * team form — they are a team run's cast, not a chat's subagents.
 */
import {
  ArrowLeft,
  Check,
  Copy,
  FileText,
  FolderOpen,
  Lock,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  AGENT_COLORS,
  type AgentEntry,
  type LibraryEntry,
  type LibraryKind,
  type LibrarySource,
  type LibraryTarget,
  type TeamLibraryResponse,
} from '../../../shared/protocol.js'
import { bodyOf, readFields, setBody, setField, slugName } from '../../../shared/skillFile.js'
import {
  askClaude,
  createLibraryEntry,
  createPrompt,
  improvePrompt,
  openLibraryFolder,
  readLibraryFile,
  removeLibraryItem,
  targetCwd,
  useLibrary,
  writeLibraryFile,
  type LibraryFile,
} from '../library.js'
import { usePickableModels } from '../models.js'
import { AGENT_HEX, canSummary, loadTeamLibrary, teamsCall, type TeamLibrary } from '../teams.js'
import { Select, SelectItem } from '../ui/Select.js'
import { AgentForm, agentBody, agentProblem, blankDraft, draftFromEntry, type AgentDraft } from './AgentForm.js'
import { Markdown } from './Markdown.js'

type Filter = 'all' | LibrarySource | 'team'

const SOURCE_LABEL: Record<Filter, string> = {
  all: 'All',
  workspace: 'Workspace',
  personal: 'Personal',
  project: 'Projects',
  plugin: 'Plugins',
  team: 'Teams',
}

const SOURCE_HINT: Record<LibrarySource | 'team', (kind: LibraryKind) => string> = {
  workspace: (k) => `This workspace’s own — its sessions load them as ${k === 'skill' ? '/triage:<name>' : 'triage:<name>'}.`,
  personal: () => 'Yours, in every Claude Code session on this machine.',
  project: () => 'Checked into the project — for everyone who works in it.',
  plugin: () => 'From an installed plugin — read-only; updates replace them.',
  team: () => 'The agents team runs are made of. Chats don’t see these.',
}

/** What the list's left column holds: a library file or a team agent. */
type Row = { key: string; group: string; source: LibrarySource | 'team'; name: string; description: string; meta: ReactNode; entry?: LibraryEntry; team?: AgentEntry }

/** null = nothing open; 'new' = the create form; 'new-team' = a new team agent; otherwise a row key. */
type Selection = null | 'new' | 'new-team' | string

export function LibraryTab({ kind, refreshNonce }: { kind: LibraryKind; refreshNonce: number }) {
  const { list, error, reload } = useLibrary(kind, refreshNonce)
  const [teams, setTeams] = useState<TeamLibrary | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<Selection>(null)
  // The editor reports unsaved edits up, so leaving it can ask first.
  const dirtyRef = useRef(false)

  const loadTeams = useCallback(() => {
    if (kind === 'agent') loadTeamLibrary().then(setTeams).catch(() => setTeams(null))
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
    if (dirtyRef.current && !confirm('Discard unsaved changes?')) return
    dirtyRef.current = false
    setSelected(s)
  }

  const current = selected && selected !== 'new' && selected !== 'new-team' ? rows.find((r) => r.key === selected) : undefined
  const filters: Filter[] = ['all', 'workspace', 'personal', 'project', 'plugin', ...(kind === 'agent' ? (['team'] as const) : [])]
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

// ---------------------------------------------------------------------------
// New: a template now, or a session that writes it with you
// ---------------------------------------------------------------------------

const TEAM_TARGET = 'team'

function NewForm({
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

/** The phone's way back from an editor to the list (hidden where both show at once). */
function BackToList({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="iconBtn lbBack" aria-label="Back to the list" title="Back" onClick={onBack}>
      <ArrowLeft size={14} aria-hidden="true" />
    </button>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="lbField">
      <span className="lbFieldK">{label}</span>
      <span className="lbFieldV">
        {children}
        {hint && <span className="lbHint">{hint}</span>}
      </span>
    </label>
  )
}

// ---------------------------------------------------------------------------
// One skill or agent file
// ---------------------------------------------------------------------------

const MODEL_ALIASES = ['inherit', 'fable', 'opus', 'sonnet', 'haiku']

function EntryEditor({
  entry,
  onBack,
  onDirty,
  onDeleted,
}: {
  entry: LibraryEntry
  /** back to the list — only shown on a phone, where the list and the editor take turns */
  onBack: () => void
  onDirty: (dirty: boolean) => void
  onDeleted: () => void
}) {
  const [file, setFile] = useState<LibraryFile | null>(null)
  const [path, setPath] = useState(entry.path)
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'form' | 'raw'>('form')
  const [preview, setPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [confirming, setConfirming] = useState<null | 'item' | 'file'>(null)
  const [copied, setCopied] = useState(false)

  const isMain = path === entry.path
  const dirty = !!file && text !== file.text
  useEffect(() => {
    onDirty(dirty)
  }, [dirty, onDirty])

  const open = useCallback(async (p: string) => {
    setError(null)
    setConfirming(null)
    try {
      const f = await readLibraryFile(p)
      setFile(f)
      setText(f.text)
      setPath(p)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])
  useEffect(() => void open(entry.path), [entry.path, open])

  const save = useCallback(async () => {
    if (!file || !dirty || saving || !file.editable) return
    setSaving(true)
    setError(null)
    try {
      const f = await writeLibraryFile(path, text)
      setFile(f)
      setText(f.text)
      setSaved(true)
      setTimeout(() => setSaved(false), 1600)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [file, dirty, saving, path, text])

  // ⌘S / Ctrl+S saves from anywhere in the editor.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault()
      void save()
    }
  }

  const switchFile = (rel: string) => {
    const p = `${file!.dir}/${rel}`
    if (p === path) return
    if (dirty && !confirm('Discard unsaved changes to this file?')) return
    void open(p)
  }

  async function remove(which: 'item' | 'file') {
    setError(null)
    try {
      await removeLibraryItem(path, which === 'file')
      if (which === 'item') onDeleted()
      else void open(entry.path)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const fields = useMemo(() => readFields(text), [text])
  const readOnly = !file?.editable
  const rel = file ? path.slice(file.dir.length + 1) : ''
  const isMd = path.endsWith('.md')
  const noun = entry.kind === 'skill' ? 'skill' : 'agent'

  return (
    <div className="lbEditor" onKeyDown={onKeyDown}>
      <header className="lbHead">
        <BackToList onBack={onBack} />
        <div className="lbHeadT">
          <div className="lbHeadName">
            <span className="mono">{entry.kind === 'skill' ? `/${entry.name}` : entry.name}</span>
            <span className={`lbSrc ${entry.source}`}>{entry.source === 'workspace' ? 'Workspace' : entry.source === 'personal' ? 'Personal' : entry.scope}</span>
            {readOnly && file && !file.binary && (
              <span className="lbSrc ro">
                <Lock size={10} aria-hidden="true" /> read-only
              </span>
            )}
          </div>
          <button
            type="button"
            className="lbHeadPath mono"
            title="Copy path"
            onClick={() => {
              void navigator.clipboard?.writeText(path)
              setCopied(true)
              setTimeout(() => setCopied(false), 1200)
            }}
          >
            {path.replace(/^\/Users\/[^/]+/, '~')} {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
          </button>
        </div>
        <span className="lbHeadActs">
          {entry.editable && (
            <button type="button" className="btn sm ghost" title="Opens a new session asking Claude to change it" onClick={() => askClaude(`Improve ${entry.name}`, improvePrompt(entry))}>
              <Sparkles size={12} aria-hidden="true" /> Improve with Claude
            </button>
          )}
          <button type="button" className="iconBtn" title="Open folder" aria-label="Open folder" onClick={() => void openLibraryFolder(entry.path).catch((e) => setError(String(e)))}>
            <FolderOpen size={13} aria-hidden="true" />
          </button>
          {entry.editable && (
            <button type="button" className="iconBtn" title={`Delete ${noun}`} aria-label={`Delete ${noun}`} onClick={() => setConfirming('item')}>
              <Trash2 size={13} aria-hidden="true" />
            </button>
          )}
        </span>
      </header>

      {confirming && (
        <div className="lbConfirm">
          <span>
            {confirming === 'item'
              ? `Delete ${entry.name}${entry.kind === 'skill' ? ' and every file in its folder' : ''}? It moves to ~/.triage/trash, and open sessions stop seeing it.`
              : `Delete ${rel}? It moves to ~/.triage/trash.`}
          </span>
          <span className="sp" />
          <button type="button" className="btn sm danger" onClick={() => void remove(confirming)}>
            Delete
          </button>
          <button type="button" className="btn sm ghost" onClick={() => setConfirming(null)}>
            Cancel
          </button>
        </div>
      )}

      {file && file.files.length > 1 && (
        <nav className="lbFiles" aria-label="Files in this skill">
          {file.files.map((f) => (
            <button key={f} type="button" className={`lbFile${f === rel ? ' on' : ''}`} onClick={() => switchFile(f)} title={f}>
              <FileText size={11} aria-hidden="true" /> {f}
            </button>
          ))}
        </nav>
      )}

      <div className="lbBody">
        {!file && !error && <div className="pickerLoading">Loading…</div>}
        {file?.binary && <div className="lbNone">Not a text file (or too big to edit here) — open the folder to work on it.</div>}
        {file && !file.binary && isMain && mode === 'form' && (
          <div className="lbFields">
            <Field label="Name" hint={entry.kind === 'skill' ? 'What / calls it. Defaults to the folder name.' : 'The subagent type Claude spawns it by.'}>
              <input className="teamInp wide" value={fields.name ?? ''} disabled={readOnly} onChange={(e) => setText(setField(text, 'name', e.target.value))} />
            </Field>
            <Field label="Description" hint={entry.kind === 'skill' ? 'Claude reads this to decide when to load the skill — say what it does and when.' : 'Claude reads this to decide when to hand work over — say when.'}>
              <textarea
                className="teamArea lbArea"
                rows={Math.min(8, Math.max(3, Math.ceil((fields.description ?? '').length / 90)))}
                value={fields.description ?? ''}
                disabled={readOnly}
                onChange={(e) => setText(setField(text, 'description', e.target.value))}
              />
            </Field>
            {entry.kind === 'agent' && <AgentFields fields={fields} readOnly={readOnly} onSet={(k, v) => setText(setField(text, k, v))} />}
            <div className="lbField col">
              <span className="lbFieldK row">
                {entry.kind === 'skill' ? 'Instructions' : 'System prompt'}
                <span className="seg lbSeg">
                  <button type="button" className={`segBtn${!preview ? ' active' : ''}`} onClick={() => setPreview(false)}>
                    Edit
                  </button>
                  <button type="button" className={`segBtn${preview ? ' active' : ''}`} onClick={() => setPreview(true)}>
                    Preview
                  </button>
                </span>
              </span>
              {preview ? (
                <div className="lbPreview">
                  <Markdown text={bodyOf(text)} />
                </div>
              ) : (
                <textarea className="lbCode" spellCheck={false} value={bodyOf(text)} readOnly={readOnly} onChange={(e) => setText(setBody(text, e.target.value))} />
              )}
            </div>
          </div>
        )}
        {file && !file.binary && (!isMain || mode === 'raw') && (
          <div className="lbRaw">
            {isMd && preview ? (
              <div className="lbPreview">
                <Markdown text={text} />
              </div>
            ) : (
              <textarea className="lbCode fill" spellCheck={false} value={text} readOnly={readOnly} onChange={(e) => setText(e.target.value)} />
            )}
          </div>
        )}
      </div>

      <footer className="lbFoot">
        {file && !file.binary && (
          <span className="seg">
            {isMain ? (
              <>
                <button type="button" className={`segBtn${mode === 'form' ? ' active' : ''}`} onClick={() => setMode('form')}>
                  Fields
                </button>
                <button type="button" className={`segBtn${mode === 'raw' ? ' active' : ''}`} onClick={() => setMode('raw')} title="The whole file, frontmatter included">
                  Raw file
                </button>
              </>
            ) : (
              isMd && (
                <button type="button" className={`segBtn${preview ? ' active' : ''}`} onClick={() => setPreview((p) => !p)}>
                  Preview
                </button>
              )
            )}
          </span>
        )}
        {!isMain && entry.editable && (
          <button type="button" className="btn sm ghost" onClick={() => setConfirming('file')}>
            Delete file
          </button>
        )}
        {error && <span className="lbErr">{error}</span>}
        <span className="sp" />
        {saved && (
          <span className="lbSaved">
            <Check size={12} aria-hidden="true" /> Saved — live in open sessions
          </span>
        )}
        {dirty && !saved && <span className="lbDirty">Unsaved</span>}
        {dirty && (
          <button type="button" className="btn ghost" onClick={() => setText(file!.text)}>
            Revert
          </button>
        )}
        {!readOnly && (
          <button type="button" className="btn primary" disabled={!dirty || saving} onClick={() => void save()} title="⌘S">
            {saving ? 'Saving…' : 'Save'}
          </button>
        )}
      </footer>
    </div>
  )
}

/** An agent file's own keys: model, tools, colour. */
function AgentFields({ fields, readOnly, onSet }: { fields: Record<string, string>; readOnly: boolean; onSet: (key: string, value: string | null) => void }) {
  const models = usePickableModels().filter((m) => m.id !== 'default')
  const model = fields.model ?? ''
  const ids = [...MODEL_ALIASES, ...models.map((m) => m.id).filter((id) => !MODEL_ALIASES.includes(id))]
  return (
    <>
      <Field label="Model" hint="Unset follows Claude Code’s subagent default; inherit uses the chat’s model.">
        <Select className="teamSel" aria-label="Model" value={model} disabled={readOnly} onValueChange={(v) => onSet('model', v || null)}>
          <SelectItem value="">Default</SelectItem>
          {ids.map((id) => (
            <SelectItem key={id} value={id} description={models.find((m) => m.id === id)?.description}>
              {models.find((m) => m.id === id)?.name ?? id}
            </SelectItem>
          ))}
          {model && !ids.includes(model) && <SelectItem value={model}>{model}</SelectItem>}
        </Select>
      </Field>
      <Field label="Tools" hint="Comma-separated, e.g. Read, Grep, Glob, Bash. Empty = every tool the chat has.">
        <input className="teamInp wide mono" value={fields.tools ?? ''} disabled={readOnly} placeholder="all tools" onChange={(e) => onSet('tools', e.target.value)} />
      </Field>
      <Field label="Colour">
        <span className="lbColors">
          <button type="button" className={`lbColor none${!fields.color ? ' on' : ''}`} disabled={readOnly} title="None" aria-label="No colour" onClick={() => onSet('color', null)} />
          {AGENT_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`lbColor${fields.color === c ? ' on' : ''}`}
              style={{ background: AGENT_HEX[c] }}
              disabled={readOnly}
              title={c}
              aria-label={c}
              onClick={() => onSet('color', c)}
            />
          ))}
        </span>
      </Field>
    </>
  )
}

// ---------------------------------------------------------------------------
// A team agent: the team form, saved through the teams API (server/teams.ts)
// ---------------------------------------------------------------------------

function TeamAgentEditor({
  entry,
  taken,
  onBack,
  onDirty,
  onSaved,
}: {
  /** null: a new one */
  entry: AgentEntry | null
  onBack: () => void
  taken: AgentEntry[]
  onDirty: (d: boolean) => void
  onSaved: (l: TeamLibrary, name: string) => void
}) {
  const [agent, setAgent] = useState<AgentDraft>(() => (entry ? draftFromEntry(entry) : blankDraft(taken)))
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const problem = agentProblem(agent)
  useEffect(() => {
    onDirty(dirty)
  }, [dirty, onDirty])

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const b = await teamsCall<TeamLibraryResponse>('PUT', 'agent', agentBody(agent))
      if (!b.ok) throw new Error(b.error)
      setDirty(false)
      // A new file is named after its label; find it by that, or by being the one that wasn't there.
      const name = entry?.name ?? b.agents.find((a) => !taken.some((t) => t.name === a.name))?.name ?? slugName(agent.label)
      onSaved({ teams: b.teams, agents: b.agents, dir: b.dir }, name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lbEditor">
      <header className="lbHead">
        <BackToList onBack={onBack} />
        <div className="lbHeadT">
          <div className="lbHeadName">
            <span className="lbSwatch" style={{ background: AGENT_HEX[agent.color] }} aria-hidden="true" />
            <span>{entry?.label ?? (agent.label || 'New team agent')}</span>
            <span className="lbSrc team">Teams</span>
            {entry && entry.status !== 'yours' && (
              <span className="lbSrc">{entry.status === 'default' ? 'triage default' : entry.status === 'edited' ? 'edited default' : 'newer default available'}</span>
            )}
          </div>
          <div className="lbHeadSub">
            {entry ? (entry.usedBy.length ? `Used by ${entry.usedBy.join(', ')}` : 'No team uses it yet') : 'A team run’s cast — a recipe step names it'} · teams are under Teams
          </div>
        </div>
      </header>
      <div className="lbBody">
        <AgentForm
          agent={agent}
          usedBy={entry?.usedBy ?? []}
          onChange={(patch) => {
            setAgent((a) => ({ ...a, ...patch }))
            setDirty(true)
          }}
        />
      </div>
      <footer className="lbFoot">
        <span className="mono lbHint">{entry ? `agents/${entry.name}.md` : ''}</span>
        <span className="sp" />
        {(error || problem) && <span className={`lbErr${!error && problem?.quiet ? ' quiet' : ''}`}>{error ?? problem?.message}</span>}
        {dirty && <span className="lbDirty">Unsaved</span>}
        <button type="button" className="btn primary" disabled={busy || !dirty || !!problem} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save agent'}
        </button>
      </footer>
    </div>
  )
}

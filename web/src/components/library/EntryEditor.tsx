import { Lock, Check, Copy, Sparkles, FolderOpen, Trash2, FileText } from 'lucide-react'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { type LibraryEntry, AGENT_COLORS, type AgentEntry, type TeamLibraryResponse } from '../../../../shared/protocol.js'
import { readFields, setField, bodyOf, setBody, slugName } from '../../../../shared/skillFile.js'
import { type LibraryFile, readLibraryFile, writeLibraryFile, removeLibraryItem, askClaude, improvePrompt, openLibraryFolder } from '../../library.js'
import { usePickableModels } from '../../models.js'
import { AGENT_HEX, type TeamLibrary, teamsCall } from '../../teams.js'
import { Select, SelectItem } from '../../ui/Select.js'
import { type AgentDraft, draftFromEntry, blankDraft, agentProblem, agentBody, AgentForm } from '../AgentForm.js'
import { Markdown } from '../Markdown.js'
import { BackToList, Field } from './fields.js'

// One skill or agent file

const MODEL_ALIASES = ['inherit', 'fable', 'opus', 'sonnet', 'haiku']

export function EntryEditor({
  entry,
  onBack,
  onDirty,
  onDeleted,
}: {
  entry: LibraryEntry
  /** back to the list, only shown on a phone, where the list and the editor take turns */
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

// A team agent: the team form, saved through the teams API (server/teams.ts)

export function TeamAgentEditor({
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

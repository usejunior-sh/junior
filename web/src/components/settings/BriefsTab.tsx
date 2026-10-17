import { useState, useEffect } from 'react'
import type { PlaybooksResponse, PlaybookResponse } from '../../../../shared/protocol.js'
import { useModels, usePickableModels, findModel } from '../../models.js'
import { playbookLabel } from '../../itemUi.js'
import { Select, SelectItem } from '../../ui/Select.js'
import { Row, Section, useWorkspaceSettings } from './shared.js'

// ---------------------------------------------------------------------------
// Briefs — the daily cap, the default model, and the two prose files per kind.
// ---------------------------------------------------------------------------

export function BriefsTab() {
  const { settings, error, save } = useWorkspaceSettings()
  const models = useModels()
  const pickable = usePickableModels(settings?.briefsDefaultModel ?? undefined)
  const [cap, setCap] = useState<string>('')
  useEffect(() => {
    if (settings) setCap(String(settings.briefsDailyCap))
  }, [settings])

  return (
    <>
      <Section
        title="Running briefs"
        hint="A brief is a playbook run against one work item that writes a markdown document beside it. Runs queue in order, one at a time, and stop at the cap — nothing runs until you queue it."
      >
        <Row label="Daily cap" hint="How many brief runs may start per day in this workspace. The tail of a batch fails with a clear reason rather than running past it.">
          <input
            className="setNum"
            type="number"
            min={1}
            max={500}
            value={cap}
            disabled={!settings}
            onChange={(e) => setCap(e.target.value)}
            onBlur={() => {
              const n = Number(cap)
              if (settings && Number.isInteger(n) && n >= 1 && n <= 500 && n !== settings.briefsDailyCap) void save({ briefsDailyCap: n })
              else if (settings) setCap(String(settings.briefsDailyCap))
            }}
          />
        </Row>
        <Row label="Default model" hint="What a brief runs on when the Create-brief dialog doesn’t pick one. Cheaper models are usually enough for reading.">
          <Select
            className="setSelect"
            aria-label="Default model"
            value={settings?.briefsDefaultModel ?? ''}
            disabled={!settings}
            onValueChange={(v) => void save({ briefsDefaultModel: v || null })}
          >
            <SelectItem value="">Claude Code default</SelectItem>
            {pickable.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </Select>
        </Row>
        {settings?.briefsDefaultModel && !findModel(models, settings.briefsDefaultModel) && (
          <p className="hint">Default model “{settings.briefsDefaultModel}” is not in the probed list; it is passed through as-is.</p>
        )}
        {error && <div className="msg error">{error}</div>}
      </Section>
      <ProseFileSection
        title="Playbooks"
        hint="One markdown file per kind of work item — what to read, what to look for, the headings the brief should have. Edited here or in the file; a brief run pastes it into its first message."
        listUrl="/api/playbooks"
        fileUrl={(kind) => `/api/playbooks?kind=${encodeURIComponent(kind)}`}
      />
      <ProseFileSection
        title="Dispatch templates"
        hint="How a dispatched session opens, per kind. A tiny template: {{title}}, {{url}}, {{description}}, {{reason}}, {{note}}, and {{#brief}}…{{/brief}} when a brief exists."
        listUrl="/api/playbooks"
        fileUrl={(kind) => `/api/dispatch/template?kind=${encodeURIComponent(kind)}`}
      />
    </>
  )
}

/** A per-kind markdown file with a kind picker, a textarea and Save — playbooks and dispatch templates share it. */
function ProseFileSection({
  title,
  hint,
  listUrl,
  fileUrl,
}: {
  title: string
  hint: string
  listUrl: string
  fileUrl: (kind: string) => string
}) {
  const [kinds, setKinds] = useState<{ kind: string; custom: boolean }[]>([])
  const [kind, setKind] = useState('manual')
  const [body, setBody] = useState('')
  const [loaded, setLoaded] = useState('')
  const [path, setPath] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetch(listUrl)
      .then((r) => r.json() as Promise<PlaybooksResponse>)
      .then((b) => {
        if (b.ok) setKinds(b.playbooks.map((p) => ({ kind: p.kind, custom: p.custom })))
      })
      .catch(() => {})
  }, [listUrl])

  useEffect(() => {
    setError(null)
    void fetch(fileUrl(kind))
      .then((r) => r.json() as Promise<PlaybookResponse>)
      .then((b) => {
        if (b.ok) {
          setBody(b.body)
          setLoaded(b.body)
          setPath(b.path ?? '')
        } else setError(b.error)
      })
      .catch((e) => setError(String(e)))
  }, [kind, fileUrl])

  async function saveFile() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(fileUrl(kind), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      const b = (await res.json()) as PlaybookResponse
      if (b.ok) {
        setLoaded(b.body)
        setKinds((prev) => prev.map((k) => (k.kind === kind ? { ...k, custom: b.custom ?? k.custom } : k)))
      } else setError(b.error)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const dirty = body !== loaded
  return (
    <Section title={title} hint={hint}>
      <div className="setPlaybook">
        <div className="head">
          <Select className="setSelect" value={kind} onValueChange={setKind} aria-label="Kind">
            {(kinds.length ? kinds : [{ kind: 'manual', custom: false }]).map((k) => (
              <SelectItem key={k.kind} value={k.kind}>
                {playbookLabel(k.kind)}
                {k.custom ? ' · edited' : ''}
              </SelectItem>
            ))}
          </Select>
          <span className="spacer" />
          <button type="button" className="btn sm" disabled={!dirty || saving} onClick={() => void saveFile()}>
            {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
          </button>
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} aria-label={`${title} for ${kind}`} />
        {path && <div className="path" title={path}>{path}</div>}
        {error && <div className="msg error">{error}</div>}
      </div>
    </Section>
  )
}

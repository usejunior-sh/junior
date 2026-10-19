import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, FileX } from 'lucide-react'
import type { Artifact, ArtifactResponse, Link } from '../../../shared/protocol.js'
import { useSessions } from '../hooks.js'
import { useInbox } from '../inboxStore.js'
import { artifactStore } from '../artifactStore.js'
import { fetchArtifactContent, openArtifactFile, useArtifactText, useArtifactVersions } from '../artifactsClient.js'
import { compareMode, originSession, previousVersion, textChanges } from '../artifactView.js'
import { store } from '../store.js'
import { ArtifactEditor } from './ArtifactEditor.js'
import { DiffView } from './DiffView.js'
import { ArtifactHeader } from './artifact/ArtifactHeader.js'
import { ArtifactView } from './artifact/ArtifactView.js'
import { VersionBar, type Compare } from './artifact/VersionBar.js'

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; artifact: Artifact; body: string; links: Link[]; abs: string; version: number; latest: boolean; truncated: boolean }
  | { phase: 'error'; message: string }

/**
 * One artifact: the file in the viewer its format wants (artifact/ArtifactView),
 * a header with its details and actions (artifact/ArtifactHeader), and its versions
 * when there is more than one. Edit (markdown
 * only; `#/artifact/new` too) hands the whole content area to the
 * ArtifactEditor, long notes need the room, and the page follows the file
 * when it changes on disk.
 */
export function ArtifactPage({
  id,
  onNavigate,
  onDirty,
}: {
  id: string
  onNavigate: (hash: string) => void
  /** Editing here means the tab must survive: promote it out of the peek slot. */
  onDirty: () => void
}) {
  if (id === 'new') return <NewArtifactPage onNavigate={onNavigate} />
  // keyed: another artifact starts from scratch, with no version or comparison carried over
  return <ExistingArtifactPage key={id} id={id} onNavigate={onNavigate} onDirty={onDirty} />
}

/** `#/artifact/new`: a fresh full-page editor; saving lands on the new artifact's page. */
function NewArtifactPage({ onNavigate }: { onNavigate: (hash: string) => void }) {
  return (
    <div id="artifactPage" className="page artEditPage">
      <ArtifactEditor
        draftKey="new"
        initialTitle=""
        initialBody=""
        crumb="Artifacts › New note"
        saveLabel="Create"
        onCancel={() => onNavigate('/artifacts')}
        onSave={async (title, body) => {
          const res = await fetch('/api/artifacts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ title, body }),
          })
          const b = (await res.json()) as ArtifactResponse
          if (!b.ok) return b.error
          void artifactStore.refresh()
          onNavigate(`/artifact/${b.artifact.id}`)
          return null
        }}
      />
    </div>
  )
}

function ExistingArtifactPage({ id, onNavigate, onDirty }: { id: string; onNavigate: (hash: string) => void; onDirty: () => void }) {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const [editing, setEditing] = useState(false)
  // Opening the editor commits you to this note: keep its tab.
  useEffect(() => {
    if (editing) onDirty()
  }, [editing, onDirty])
  /** a past version on show; null follows the latest */
  const [selected, setSelected] = useState<number | null>(null)
  const [compare, setCompare] = useState<Compare>({ on: false, side: 'new' })
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const inbox = useInbox()
  const sessions = useSessions()
  const versions = useArtifactVersions(id)

  // An answer for a version you have since left must not land on the screen.
  const ask = useRef(0)
  const load = useCallback(async () => {
    const mine = ++ask.current
    const b = await fetchArtifactContent(id, selected ?? undefined)
    if (mine !== ask.current) return
    if (b.ok) {
      setState({ phase: 'ready', artifact: b.artifact, body: b.body, links: b.links, abs: b.abs, version: b.version, latest: b.latest, truncated: b.truncated })
    } else if (selected !== null) {
      // that version cannot be read (no history kept, or it is gone): go back to the latest
      setSelected(null)
      setNotice(`v${selected} cannot be opened: ${b.error}`)
    } else {
      setState({ phase: 'error', message: b.error })
    }
  }, [id, selected])

  useEffect(() => {
    void load()
  }, [load])

  // The file may change under us (your editor, a session), follow it, unless mid-edit.
  useEffect(() => store.onArtifactsChanged(() => void load()), [load])

  useEffect(() => {
    if (!notice) return
    const t = window.setTimeout(() => setNotice(null), 2500)
    return () => window.clearTimeout(t)
  }, [notice])

  const pick = useCallback((v: number | null) => {
    setSelected(v)
    setCompare({ on: false, side: 'new' })
  }, [])

  async function save(title: string, body: string): Promise<string | null> {
    const res = await fetch(`/api/artifacts?id=${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, body }),
    })
    const b = (await res.json()) as ArtifactResponse
    if (!b.ok) return b.error
    setEditing(false)
    await load()
    return null
  }

  async function remove() {
    setBusy('delete')
    try {
      const res = await fetch(`/api/artifacts?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
      const b = (await res.json()) as { ok: boolean; error?: string }
      if (b.ok) onNavigate('/artifacts')
      else setNotice(b.error ?? 'could not delete')
    } finally {
      setBusy(null)
    }
  }

  async function openOnMac(mode: 'editor' | 'reveal' | 'default') {
    setBusy('open')
    try {
      const err = await openArtifactFile(id, mode)
      setNotice(err ?? (mode === 'editor' ? 'Opened in your editor' : mode === 'default' ? 'Opened in its app' : 'Shown in the file manager'))
    } finally {
      setBusy(null)
    }
  }

  async function copy(what: 'mention' | 'path') {
    const text = what === 'mention' ? `@artifact:${id}` : abs
    try {
      await navigator.clipboard.writeText(text)
      setNotice(what === 'mention' ? 'Copied. Paste it into any chat.' : 'Path copied')
    } catch {
      setNotice(text)
    }
  }

  if (state.phase === 'loading') return <div className="page">Loading…</div>
  if (state.phase === 'error') {
    const gone = /no such artifact|ENOENT|no such file/i.test(state.message)
    return (
      <div className="page">
        <button type="button" className="artBack" onClick={() => onNavigate('/artifacts')}>
          <ArrowLeft size={12} aria-hidden="true" /> Artifacts
        </button>
        {gone ? (
          <div className="artViewMissing">
            <FileX size={20} aria-hidden="true" />
            <p>This artifact is gone. Its file was deleted, or moved out of the artifacts folder.</p>
            <p className="artViewNote">The folder is a git repo, so an older copy may still be in its history.</p>
          </div>
        ) : (
          <div className="msg error">{state.message}</div>
        )}
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn sm" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    )
  }

  const { artifact: a, body, links, abs, version, latest, truncated } = state
  const isMd = a.format === 'md'

  // Edit mode takes the whole content area, long notes need the room.
  if (editing) {
    return (
      <div id="artifactPage" className="page artEditPage">
        <ArtifactEditor
          draftKey={a.id}
          initialTitle={a.title}
          initialBody={body}
          crumb={`Artifacts › ${a.path}`}
          saveLabel="Save"
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      </div>
    )
  }

  const itemTitle = (itemId: string) => inbox.items.find((i) => i.id === itemId)?.title ?? itemId
  /** null when no such session exists any more */
  const sessionTitle = (sid: string): string | null => sessions.find((s) => s.id === sid)?.title ?? null
  const origin = originSession({ links })
  const originTitle = origin ? sessionTitle(origin) : null
  const newest = versions.data?.current ?? Math.max(version, a.version)
  const prev = versions.data?.history ? previousVersion(versions.data.versions, version) : undefined
  const comparing = compare.on && !!prev
  // a body the server cut at the inline cap would be saved back short
  const canEdit = isMd && latest && !truncated

  const showVersions = versions.state === 'ready' && !!versions.data && (versions.data.versions.length > 1 || !versions.data.history || version !== newest)

  return (
    <div id="artifactPage" className="page">
      <div className="inner">
        <button type="button" className="artBack" onClick={() => onNavigate('/artifacts')}>
          <ArrowLeft size={12} aria-hidden="true" /> Artifacts
        </button>

        <ArtifactHeader
          artifact={a}
          version={version}
          newest={newest}
          latest={latest}
          abs={abs}
          origin={origin}
          originTitle={originTitle}
          links={links}
          itemTitle={itemTitle}
          sessionTitle={sessionTitle}
          canEdit={canEdit}
          busy={busy !== null}
          confirmingDelete={confirmDelete}
          onNavigate={onNavigate}
          onEdit={() => setEditing(true)}
          onOpenOnMac={(mode) => void openOnMac(mode)}
          onCopy={(what) => void copy(what)}
          onAskDelete={() => setConfirmDelete(true)}
          onCancelDelete={() => setConfirmDelete(false)}
          onDelete={() => void remove()}
        />

        {showVersions && (
          <VersionBar
            format={a.format}
            state={versions.state}
            data={versions.data}
            error={versions.error}
            version={version}
            latest={newest}
            sessionTitle={sessionTitle}
            onSelect={pick}
            compare={compare}
            onCompare={setCompare}
          />
        )}

        {notice && <div className="notice">{notice}</div>}

        <div className="card artViewWrap" onDoubleClick={canEdit ? () => setEditing(true) : undefined} title={canEdit ? 'Double-click to edit' : undefined}>
          {comparing && prev && compareMode(a.format) === 'text' ? (
            <TextChanges id={id} before={prev.version} version={version} after={body} />
          ) : comparing && prev && compare.side === 'old' ? (
            <OldVersion artifact={a} version={prev.version} />
          ) : (
            <ArtifactView artifact={a} body={body} truncated={truncated} version={version} />
          )}
        </div>
      </div>
    </div>
  )
}

/** The lines that changed between the version before `version` and `version`, for md, csv, txt and json. */
function TextChanges({ id, before, version, after }: { id: string; before: number; version: number; after: string }) {
  const old = useArtifactText(id, before)
  const r = useMemo(() => (old.state === 'ready' ? textChanges(old.text, after) : null), [old.state, old.text, after])
  if (old.state === 'loading') return <div className="artView artViewEmpty artEmpty">Loading v{before}…</div>
  if (old.state === 'error' || !r) return <div className="artView artViewEmpty artEmpty">Could not read v{before} to compare.</div>
  return (
    <div className="artView artViewDiff">
      <div className="artViewBar">
        <span className="artCsvInfo">
          v{before} → v{version}
        </span>
        <span className="artDiffCount">
          <span className="add">+{r.diff.additions}</span> <span className="del">−{r.diff.deletions}</span>
        </span>
      </div>
      {r.changed ? (
        <DiffView diff={r.diff} mode="unified" />
      ) : (
        <div className="artEmpty artViewEmpty">No change in the text. Only the title or details moved.</div>
      )}
    </div>
  )
}

/** The older side of an Old / New comparison: the same viewer, at the version before. */
function OldVersion({ artifact, version }: { artifact: Artifact; version: number }) {
  // An svg also shows its source, and that has to be the old source too.
  if (artifact.format === 'svg') return <OldSvg artifact={artifact} version={version} />
  return <ArtifactView artifact={artifact} body="" truncated={false} version={version} />
}

function OldSvg({ artifact, version }: { artifact: Artifact; version: number }) {
  const old = useArtifactText(artifact.id, version)
  return <ArtifactView artifact={artifact} body={old.text} truncated={old.truncated} version={version} />
}

import { useEffect, useState } from 'react'
import { FileText, Plus, RefreshCw } from 'lucide-react'
import type { ArtifactWithLinks } from '../../../shared/protocol.js'
import { rowOpen } from '../tabs.js'
import { artifactStore, useArtifacts } from '../artifactStore.js'

type Filter = 'all' | 'human' | 'model'

const tilde = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

function when(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h`
  return `${Math.round(mins / 1440)}d`
}

/**
 * The Artifacts page: every markdown note and brief in the workspace's
 * artifacts folder, straight from the index. A list, not a tree — the folder is
 * shallow by design (notes/, briefs/). Briefs of finished items hide by default.
 */
export function ArtifactsPage({ onOpen, onPin }: { onOpen: (id: string) => void; onPin: (id: string, title: string) => void }) {
  const snap = useArtifacts()
  const [filter, setFilter] = useState<Filter>('all')
  const [showFinished, setShowFinished] = useState(false)

  useEffect(() => {
    void artifactStore.refresh(showFinished)
  }, [showFinished])

  const rows = snap.artifacts.filter((a) => (filter === 'all' || a.author === filter) && (showFinished || !a.hidden))

  return (
    <div id="artifactsPage" className="page full">
      <div className="inner">
        <div className="pageHead">
          <div>
            <h1 className="display md">Artifacts</h1>
            <p className="sub">
              Markdown notes and briefs kept beside your work items. Files are the truth — edit them in
              your editor or here — and any session can read one with <code>@artifact:</code>.
            </p>
          </div>
          <button className="btn primary" onClick={() => onOpen('new')} title="Opens a full-page editor">
            <Plus size={14} aria-hidden="true" />
            New note
          </button>
        </div>

        <div className="artTools">
          <div className="seg" role="tablist" aria-label="Author">
            {(['all', 'human', 'model'] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                className={`segBtn${filter === f ? ' active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'human' ? 'Yours' : 'Model'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`btn xs${showFinished ? '' : ' ghost'}`}
            onClick={() => setShowFinished((v) => !v)}
            title="Briefs of done or archived items are hidden by default"
          >
            {showFinished ? 'Hiding nothing' : 'Show finished'}
          </button>
          <span className="spacer" />
          {snap.root && (
            <span className="root" title={snap.root}>
              {tilde(snap.root)}
            </span>
          )}
          <button
            type="button"
            className="iconBtn sm"
            title="Re-index the folder now"
            onClick={() => {
              void fetch(`/api/artifacts/reindex${showFinished ? '?all=1' : ''}`, { method: 'POST' }).then(() =>
                artifactStore.refresh(showFinished),
              )
            }}
          >
            <RefreshCw size={13} aria-hidden="true" />
          </button>
        </div>

        {snap.error && <div className="msg error">{snap.error}</div>}
        {!snap.loaded && !snap.error && <div className="pickerLoading">Loading…</div>}

        {snap.loaded &&
          (rows.length > 0 ? (
            <div className="list artList">
              {rows.map((a) => (
                <ArtifactRow key={a.id} a={a} onOpen={() => onOpen(a.id)} onPin={() => onPin(a.id, a.title)} />
              ))}
            </div>
          ) : (
            <div className="inboxEmpty">
              {snap.artifacts.length === 0
                ? 'No artifacts yet. Add a note, or drop a .md file into the folder above.'
                : 'Nothing matches this filter.'}
            </div>
          ))}
      </div>

    </div>
  )
}

function ArtifactRow({ a, onOpen, onPin }: { a: ArtifactWithLinks; onOpen: () => void; onPin: () => void }) {
  const n = a.links.length
  return (
    <button type="button" className="listRow artRow" {...rowOpen(onOpen, onPin)} title={a.title}>
      <FileText size={14} aria-hidden="true" />
      <span className="artTitle">{a.title}</span>
      <span className={`pill ${a.author === 'model' ? 'blue' : 'mute'}`}>{a.author === 'model' ? 'model' : 'you'}</span>
      {n > 0 && (
        <span className="pill mute" title="linked items and sessions">
          {n} link{n === 1 ? '' : 's'}
        </span>
      )}
      {a.hidden && <span className="pill mute">finished</span>}
      {a.warning && (
        <span className="pill yellow" title={a.warning}>
          frontmatter
        </span>
      )}
      <span className="artPath" title={a.path}>
        {a.path}
      </span>
      <span className="artWhen" title={new Date(a.updated).toLocaleString()}>
        {when(a.updated)}
      </span>
    </button>
  )
}

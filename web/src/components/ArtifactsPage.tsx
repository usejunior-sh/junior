import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { MessagesSquare, Plus, RefreshCw } from 'lucide-react'
import type { ArtifactWithLinks } from '../../../shared/protocol.js'
import { rowOpen } from '../tabs.js'
import { artifactStore, useArtifacts } from '../artifactStore.js'
import { artifactRawUrl } from '../artifactsClient.js'
import { artifactAgo, FORMAT_CHIPS, formatLabel, FormatIcon, type FormatChip } from '../artifactFormat.js'
import {
  artifactsRoute,
  chipCounts,
  filterArtifacts,
  originSession,
  outputSessions,
  sessionFromHash,
  tilde,
  type AuthorFilter,
} from '../artifactView.js'
import { useSessions } from '../hooks.js'
import { Select, SelectItem } from '../ui/Select.js'

const AUTHORS: { id: AuthorFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'human', label: 'Yours' },
  { id: 'model', label: 'Junior' },
]

const subscribeHash = (fn: () => void) => {
  addEventListener('hashchange', fn)
  return () => removeEventListener('hashchange', fn)
}

/** The session the page is narrowed to, read from `#/artifacts?session=<id>`; '' = every session. */
function useSessionFilter(): [string, (id: string) => void] {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash)
  // Replace, not push: a filter is a view of this page, not somewhere Back should return to.
  const set = (id: string) => location.replace(`#${artifactsRoute(id)}`)
  return [sessionFromHash(hash), set]
}

/**
 * The Artifacts page: every file in the workspace's artifacts folder (notes,
 * briefs, and what sessions published), straight from the index. A ledger of
 * aligned rows, not a tree: the folder is shallow by design. Chips narrow by
 * format, a menu by the session that made the file. Briefs of finished items
 * hide by default.
 */
export function ArtifactsPage({ onOpen, onPin }: { onOpen: (id: string) => void; onPin: (id: string, title: string) => void }) {
  const snap = useArtifacts()
  const sessions = useSessions()
  const [chip, setChip] = useState<FormatChip>('all')
  const [author, setAuthor] = useState<AuthorFilter>('all')
  const [session, setSession] = useSessionFilter()
  const [showFinished, setShowFinished] = useState(false)

  useEffect(() => {
    void artifactStore.refresh(showFinished)
  }, [showFinished])

  const filter = { chip, author, session, showFinished }
  const rows = filterArtifacts(snap.artifacts, filter)
  const counts = chipCounts(snap.artifacts, filter)

  /** null = no such session any more */
  const sessionTitle = (id: string): string | null => sessions.find((s) => s.id === id)?.title ?? null
  // Sessions that published something, plus the one the link names even if it has nothing (or is gone)
  const sessionIds = useMemo(() => {
    const ids = outputSessions(snap.artifacts)
    return session && !ids.includes(session) ? [session, ...ids] : ids
  }, [snap.artifacts, session])

  const narrowed = chip !== 'all' || author !== 'all' || session !== ''
  const clear = () => {
    setChip('all')
    setAuthor('all')
    if (session) setSession('')
  }

  return (
    <div id="artifactsPage" className="page full">
      <div className="inner">
        <div className="pageHead">
          <div>
            <h1 className="display md">Artifacts</h1>
            <p className="sub">
              Every file Junior publishes, and every note you keep beside your work. The files are the truth. Edit them in your
              editor, and any session can read one with <code>@artifact:</code>.
            </p>
          </div>
          <button className="btn primary" onClick={() => onOpen('new')} title="Opens a full-page editor">
            <Plus size={14} aria-hidden="true" />
            New note
          </button>
        </div>

        <div className="artTools">
          <div className="seg artChipsBar" role="tablist" aria-label="Format">
            {FORMAT_CHIPS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={chip === c.id}
                className={`segBtn${chip === c.id ? ' active' : ''}`}
                onClick={() => setChip(c.id)}
              >
                {c.label}
                <span className="segN">{counts[c.id]}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="artTools">
          <div className="seg" role="tablist" aria-label="Author">
            {AUTHORS.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={author === f.id}
                className={`segBtn${author === f.id ? ' active' : ''}`}
                onClick={() => setAuthor(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          {sessionIds.length > 0 && (
            <Select
              className="artSessionSelect"
              contentClassName="artSessionMenu"
              aria-label="From session"
              icon={<MessagesSquare size={13} aria-hidden="true" />}
              value={session}
              onValueChange={setSession}
            >
              <SelectItem value="">All sessions</SelectItem>
              {sessionIds.map((id) => (
                <SelectItem key={id} value={id}>
                  {sessionTitle(id) ?? 'A deleted session'}
                </SelectItem>
              ))}
            </Select>
          )}
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
            aria-label="Re-index the folder now"
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
              <div className="artHdr" aria-hidden="true">
                <span />
                <span>Title</span>
                <span className="artMeta">
                  <span className="cFmt">Format</span>
                  <span className="cBy">By</span>
                  <span className="cVer">Ver</span>
                  <span className="cFrom">From session</span>
                </span>
                <span className="cLinks">Links</span>
                <span className="cWhen">Age</span>
              </div>
              {rows.map((a) => (
                <ArtifactRow
                  key={a.id}
                  a={a}
                  fromTitle={(() => {
                    const sid = originSession(a)
                    return sid ? { id: sid, title: sessionTitle(sid) } : null
                  })()}
                  onOpen={() => onOpen(a.id)}
                  onPin={() => onPin(a.id, a.title)}
                />
              ))}
            </div>
          ) : (
            <div className="inboxEmpty">
              {snap.artifacts.length === 0 ? (
                "No artifacts yet. Junior's files and your notes show up here."
              ) : (
                <>
                  Nothing matches these filters.
                  {narrowed && (
                    <button type="button" className="btn sm" onClick={clear}>
                      Clear filters
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
      </div>
    </div>
  )
}

function ArtifactRow({
  a,
  fromTitle,
  onOpen,
  onPin,
}: {
  a: ArtifactWithLinks
  /** the session it was published from; title null = that session is gone */
  fromTitle: { id: string; title: string | null } | null
  onOpen: () => void
  onPin: () => void
}) {
  const n = a.links.length
  const image = a.format === 'png' || a.format === 'jpg' || a.format === 'gif' || a.format === 'webp' || a.format === 'svg'
  const [thumbBad, setThumbBad] = useState(false)
  return (
    <div className="listRow artRow" {...rowOpen(onOpen, onPin)}>
      <span className="artIcon">
        {image && !thumbBad ? (
          <img className="artThumb" src={artifactRawUrl(a.id, { v: a.version })} alt="" loading="lazy" onError={() => setThumbBad(true)} />
        ) : (
          <FormatIcon format={a.format} />
        )}
      </span>
      <span className="artTitleCell">
        <button type="button" className="artTitle" title={a.title}>
          {a.title}
        </button>
        {a.hidden && <span className="pill mute">finished</span>}
        {a.warning && (
          <span className="pill yellow" title={a.warning}>
            {a.format === 'md' ? 'frontmatter' : 'details'}
          </span>
        )}
        <span className="artPath" title={a.path}>
          {a.path}
        </span>
      </span>
      <span className="artMeta">
        <span className="cFmt">
          <span className="pill mono mute">{formatLabel(a.format)}</span>
        </span>
        <span className="cBy">
          <span className={`pill ${a.author === 'model' ? 'blue' : 'mute'}`}>{a.author === 'model' ? 'junior' : 'you'}</span>
        </span>
        <span className="cVer" title={a.history ? `${a.version} version${a.version === 1 ? '' : 's'}` : 'over 10 MB: no history kept'}>
          v{a.version}
        </span>
        <span className="cFrom">
          {fromTitle ? (
            fromTitle.title ? (
              <button
                type="button"
                className="artFromBtn"
                title={`Open the session: ${fromTitle.title}`}
                onClick={(e) => {
                  e.stopPropagation()
                  location.hash = fromTitle.id
                }}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                {fromTitle.title}
              </button>
            ) : (
              <span className="artFromGone">deleted session</span>
            )
          ) : (
            <span className="artFromNone">—</span>
          )}
        </span>
      </span>
      <span className="cLinks" title="linked items and sessions">
        {n > 0 ? `${n} link${n === 1 ? '' : 's'}` : ''}
      </span>
      <span className="cWhen" title={new Date(a.updated).toLocaleString()}>
        {artifactAgo(a.updated)}
      </span>
    </div>
  )
}

import { ArrowLeft, Copy, FileText } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TeamRunFileResponse, TeamRunFolderFile, TeamRunFolderResponse } from '../../../shared/protocol.js'
import { teamsCall } from '../teams.js'
import { Markdown } from './Markdown.js'

const STATE: Record<string, string> = { proposed: 'proposed', running: 'running', gate: 'waiting for you', waiting: 'waiting on the world', paused: 'paused', stopped: 'stopped', done: 'done' }
const GROUPS: { id: TeamRunFolderFile['group']; label: string }[] = [
  { id: 'run', label: 'The run' },
  { id: 'handoffs', label: 'Handoffs' },
  { id: 'patches', label: 'Patches' },
]

/**
 * A team run's folder, read in the app (`#/run/<run>/<file>`): the plan, the
 * ledger, how to check, the reviews and every handoff are markdown files that
 * Junior writes as the run goes (.docs/teams.md → "Handoffs and the run
 * folder"). Read-only: the run is changed from its session, never here.
 */
export function RunFolderPage({ runId, path, rev, onNavigate }: { runId: string; path: string; rev: number; onNavigate: (hash: string) => void }) {
  const [folder, setFolder] = useState<Extract<TeamRunFolderResponse, { ok: true }> | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  // The list and the open file follow the run: every change to it bumps `rev`.
  useEffect(() => {
    let live = true
    teamsCall<Extract<TeamRunFolderResponse, { ok: true }>>('GET', `folder?runId=${encodeURIComponent(runId)}`)
      .then((b) => live && (setFolder(b), setError(null)))
      .catch((err) => live && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      live = false
    }
  }, [runId, rev])
  useEffect(() => {
    let live = true
    teamsCall<Extract<TeamRunFileResponse, { ok: true }>>('GET', `file?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(path)}`)
      .then((b) => live && setText(b.text))
      .catch((err) => live && setText(`_Couldn’t read ${path}: ${err instanceof Error ? err.message : err}_`))
    return () => {
      live = false
    }
  }, [runId, path, rev])

  const open = (p: string) => onNavigate(runFileHash(runId, p))
  const file = folder?.files.find((f) => f.path === path)
  const full = folder ? `${folder.dir}/${path}` : path

  if (error) {
    return (
      <div className="page">
        <div className="inner">
          <div className="notice">{error}</div>
        </div>
      </div>
    )
  }

  return (
    <div id="runFolderPage" className="page">
      <div className="inner">
        {folder && (
          <button type="button" className="artBack" onClick={() => onNavigate(folder.leadSessionId)}>
            <ArrowLeft size={12} aria-hidden="true" /> {folder.team} team
          </button>
        )}
        <div className="artHead">
          <div>
            <h1 className="display md" style={{ margin: 0 }}>
              {file?.label ?? path}
            </h1>
            <div className="chipRow" style={{ marginTop: 10 }}>
              {folder && <span className="pill mute">{folder.title}</span>}
              {folder && <span className={`pill ${folder.state === 'gate' || folder.state === 'paused' ? 'yellow' : 'mute'}`}>{STATE[folder.state] ?? folder.state}</span>}
              <span className="pill mono mute" title={full}>
                <span className="t">{path}</span>
              </span>
              <span className="pill mute">written by Junior</span>
            </div>
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn sm"
              title={full}
              onClick={() => {
                void navigator.clipboard?.writeText(full).then(() => {
                  setCopied(true)
                  window.setTimeout(() => setCopied(false), 1500)
                })
              }}
            >
              <Copy size={13} aria-hidden="true" /> {copied ? 'Copied' : 'Copy path'}
            </button>
          </div>
        </div>

        <div className="artGrid">
          <div className="card artBody">
            {text === null ? <div className="artEmpty">Loading…</div> : path.endsWith('.md') ? <Markdown text={text} /> : <pre className="hoText">{text}</pre>}
          </div>
          <aside className="artAside rfAside">
            {GROUPS.map((g) => {
              const list = folder?.files.filter((f) => f.group === g.id) ?? []
              if (!list.length) return null
              return (
                <section key={g.id}>
                  <div className="secLabel">
                    {g.label} <span className="n">{list.length}</span>
                  </div>
                  <ul className="rfList">
                    {list.map((f) => (
                      <li key={f.path}>
                        <button type="button" className={`rfFile${f.path === path ? ' on' : ''}`} aria-current={f.path === path ? 'page' : undefined} onClick={() => open(f.path)} title={f.path}>
                          <FileText size={12} aria-hidden="true" />
                          <span className="nm">{f.label}</span>
                          {f.badge && <span className={`rfBadge ${f.badge}`}>{f.badge}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
            {folder && <div className="rfDir mono" title={folder.dir}>{folder.dir}</div>}
          </aside>
        </div>
      </div>
    </div>
  )
}

/** The hash for one file in a run's folder. */
export const runFileHash = (runId: string, path = 'plan.md') => `/run/${runId}/${path.split('/').map(encodeURIComponent).join('/')}`

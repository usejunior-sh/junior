import { ExternalLink, FileText, X, Sparkles } from 'lucide-react'
import type { ScoredItem, BriefJob, BriefView } from '../../../../shared/protocol.js'
import { briefPill } from '../../briefStore.js'
import { ago, KIND_LABEL } from '../../itemUi.js'
import { Markdown } from '../Markdown.js'

export function ItemDetails({ item, jobTitles }: { item: ScoredItem; jobTitles: Map<string, string> }) {
  return (
    <>
      <div className="card brief">
        <div className="briefHead">
          <span className="title">Details</span>
          <span className="when">updated {ago(item.updatedAt)}</span>
          <span className="right">
            {item.url && (
              <a className="btn xs" href={item.url} target="_blank" rel="noreferrer">
                Open <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}
          </span>
        </div>

        <div className="secLabel mute">Ranked because</div>
        <div className="line">
          <span className="dash">—</span>
          <span>{item.rankWhy}</span>
        </div>

        {item.why && item.source !== 'manual' && (
          <>
            <div className="secLabel mute">Match reason</div>
            <div className="quote">{item.why}</div>
          </>
        )}

        {item.foundBy && item.foundBy.length > 0 && (
          <>
            <div className="secLabel mute">
              Found by <span className="n">{item.foundBy.length}</span>
            </div>
            {item.foundBy.map((p, i) => (
              <div className="line" key={`${p.at}-${i}`}>
                <span className="dash">—</span>
                <span>
                  <span className="k">{p.jobId ? jobTitles.get(p.jobId) ?? 'a job' : 'source scan'}</span> · {ago(p.at)}
                  {p.why ? ` · ${p.why}` : ''}
                </span>
              </div>
            ))}
          </>
        )}

        <div className="secLabel mute">Source</div>
        <div className="line">
          <span className="dash">—</span>
          <span>
            <span className="k">{item.source}</span> · <span className="mono">{item.id}</span>
          </span>
        </div>
      </div>
    </>
  )
}

export function ReportCard({ report, onNavigate }: { report: { id: string; title: string; body: string; updated: number }; onNavigate: (hash: string) => void }) {
  return (
    <>
        <div className="card briefCard">
          <div className="briefHead">
            <FileText size={14} aria-hidden="true" />
            <span className="title">Report</span>
            <span className="pill mute">{report.title}</span>
            <span className="right">
              <span className="when">rewritten {ago(report.updated)}</span>
              <button type="button" className="btn xs" onClick={() => onNavigate(`/artifact/${report.id}`)}>
                Open artifact
              </button>
            </span>
          </div>
          <div className="briefBody">
            <Markdown text={report.body} />
          </div>
        </div>
    </>
  )
}

export function BriefCard({ item, job, brief, pill, settled, feedback, busy, setFeedback, setBriefOpen, iterate, cancelBrief, onNavigate }: {
  item: ScoredItem
  job: BriefJob | undefined
  brief: BriefView | null
  pill: ReturnType<typeof briefPill>
  settled: boolean
  feedback: string
  busy: string | null
  setFeedback: (text: string) => void
  setBriefOpen: (open: boolean) => void
  iterate: () => Promise<void>
  cancelBrief: () => Promise<void>
  onNavigate: (hash: string) => void
}) {
  return (
    <>
    {/* The brief: a document a playbook run wrote, rewritten in place on iteration. */}
    <div className="card briefCard">
      <div className="briefHead">
        <FileText size={14} aria-hidden="true" />
        <span className="title">Brief</span>
        {pill && (
          <span className={`pill ${pill.tone}`}>
            {job?.status === 'running' && <span className="dot live sm" aria-hidden="true" />}
            {pill.label}
          </span>
        )}
        {job?.status === 'queued' && brief?.queuePosition != null && (
          <span className="when">#{brief.queuePosition + 1} in the queue</span>
        )}
        {brief?.artifact && <span className="when">updated {ago(brief.artifact.updated)}</span>}
        <span className="right">
          {job?.sessionId && (
            <button type="button" className="btn xs" onClick={() => onNavigate(job.sessionId!)} title="The run's transcript">
              Open session
            </button>
          )}
          {brief?.artifact && (
            <button type="button" className="btn xs" onClick={() => onNavigate(`/artifact/${brief.artifact!.id}`)} title="The brief as an artifact">
              Open artifact
            </button>
          )}
          {job?.status === 'queued' && (
            <button type="button" className="btn xs ghost" onClick={() => void cancelBrief()}>
              <X size={11} aria-hidden="true" /> Cancel
            </button>
          )}
          {settled && (
            <button type="button" className="btn xs primary" onClick={() => setBriefOpen(true)}>
              <Sparkles size={11} aria-hidden="true" /> {brief?.artifact ? 'Re-brief' : 'Create brief'}
            </button>
          )}
        </span>
      </div>

      {job?.status === 'failed' && job.error && <div className="msg error">{job.error}</div>}
      {brief?.stale && settled && (
        <div className="notice">The source moved after this brief was written — re-brief to catch up.</div>
      )}

      {brief?.body ? (
        <div className="briefBody">
          <Markdown text={brief.body} />
        </div>
      ) : job?.status === 'running' ? (
        <div className="briefEmpty">The playbook is reading the item now. The brief lands here when it calls <b>write_brief</b>.</div>
      ) : job?.status === 'queued' ? (
        <div className="briefEmpty">Queued. Briefs run one at a time, in order.</div>
      ) : (
        <div className="briefEmpty">
          No brief yet. <b>Create brief</b> opens the template it runs on — the <b>{KIND_LABEL[item.kind] ?? item.kind}</b> one,
          or a type like Plan or PR summary — for you to edit before it runs. It reads, never writes, and the result lands here as a
          document you can iterate on. Or skip it and <b>Dispatch</b> if you already know what to do.
        </div>
      )}

      {brief?.body && settled && (
        <div className="briefIterate">
          <textarea
            placeholder="You missed X… — goes to the brief session as your message; it rewrites the brief"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void iterate()
            }}
          />
          <button type="button" className="btn sm" disabled={!feedback.trim() || busy === 'iterate'} onClick={() => void iterate()}>
            Send
          </button>
        </div>
      )}
    </div>
    </>
  )
}

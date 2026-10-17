import type { JobPreviewResult } from '../../../../shared/protocol.js'
import { useEvents } from '../../hooks.js'
import { labelName, relTime } from '../../itemUi.js'
import { Markdown } from '../Markdown.js'
import { Transcript } from '../Transcript.js'

export type Preview =
  | { phase: 'idle' }
  | { phase: 'running'; id: string; sig: string }
  | { phase: 'ready'; id: string; sig: string; result: JobPreviewResult }
  | { phase: 'failed'; id: string; sig: string; message: string }

// Step 2: the dry run. Transcript first (it is the proof), the would-be
// item(s) once the run ends (they are the payoff). The transcript is the same
// component the session page uses, fed by the ephemeral session's events.

export function PreviewStep({
  preview,
  stale,
  title,
  onBack,
  onAgain,
  onSave,
  saving,
  complete,
  saveLabel,
  error,
  onNavigate,
}: {
  preview: Preview
  stale: boolean
  title: string
  onBack: () => void
  onAgain: () => void
  onSave: () => void
  saving: boolean
  complete: boolean
  saveLabel: string
  error: string
  onNavigate: (hash: string) => void
}) {
  const sessionId = preview.phase === 'idle' || !preview.id ? null : preview.id
  const events = useEvents(sessionId)
  const running = preview.phase === 'running'
  const result = preview.phase === 'ready' ? preview.result : null

  const status =
    preview.phase === 'running' ? (
      <>
        <span className="dot blue live" /> Dry run of <b>{title}</b> in progress · nothing is saved
      </>
    ) : preview.phase === 'ready' ? (
      <>
        <span className="dot green" /> Dry run finished · nothing was saved
      </>
    ) : preview.phase === 'failed' ? (
      <>
        <span className="dot red" /> Dry run failed · {preview.message}
      </>
    ) : null

  return (
    <>
      <div className="previewStatus">
        {status}
        {stale && <span className="pill yellow">details changed since this run</span>}
        {result && (
          <span className="m">
            {fmtTok(result.tokens)} tok{result.costUsd != null ? ` · ${fmtUsd(result.costUsd)}` : ''} · {Math.round(result.durationMs / 1000)}s
          </span>
        )}
      </div>

      <div className="previewTranscript">
        {sessionId && events.length > 0 ? (
          <Transcript sessionId={sessionId} events={events} onRespond={() => {}} onNavigate={onNavigate} />
        ) : (
          <div className="waiting">{running ? 'Starting the run…' : 'No transcript.'}</div>
        )}
      </div>

      {result && <PreviewCard result={result} />}

      {error && <div className="formError">{error}</div>}

      <div className="foot">
        <span className="hint">{result ? 'Happy with it? Create the job and its first real run starts from now.' : 'You can create the job while the dry run is still going.'}</span>
        <button type="button" className="btn outline" onClick={onBack}>
          Back to details
        </button>
        <button type="button" className="btn" disabled={running} onClick={onAgain}>
          Preview again
        </button>
        <button type="button" className="btn primary" disabled={!complete || saving} onClick={onSave}>
          {saving ? 'Saving…' : saveLabel}
        </button>
      </div>
    </>
  )
}

const fmtTok = (n: number) => (n < 1000 ? String(n) : n < 1_000_000 ? `${Math.round(n / 1000)}k` : `${(n / 1_000_000).toFixed(1)}M`)
const fmtUsd = (n: number) => (n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`)

/** What the run would have produced, rendered the way the inbox or the item page will show it. */
function PreviewCard({ result }: { result: JobPreviewResult }) {
  return (
    <div className="card previewCard" aria-live="polite">
      <div className="head">
        <span className="t">
          {result.output === 'digest'
            ? result.digest
              ? `Would write: ${result.digest.title}`
              : 'Would write nothing — the run found nothing new'
            : result.rows.length === 0
              ? 'Would file nothing — looked, found no match'
              : `Would file ${result.rows.length} work item${result.rows.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {result.output === 'digest' ? (
        result.digest ? (
          <div className="digest">
            <div className="md">
              <Markdown text={result.digest.body} />
            </div>
          </div>
        ) : (
          <div className="empty">Nothing to show. Widen the instructions or the window if you expected something.</div>
        )
      ) : result.rows.length === 0 ? (
        <div className="empty">Nothing to show. If you expected matches, loosen the instructions and preview again.</div>
      ) : (
        result.rows.map((r) => (
          <div key={r.id} className="previewRow">
            <span className="t">
              <a href={r.url} target="_blank" rel="noreferrer">
                {r.title}
              </a>
              {r.place && <span className="place">{r.place}</span>}
              {r.ask && <span className={`place label-${r.ask}`}>{labelName(r.ask)}</span>}
            </span>
            <span className="when">{relTime(r.lastActivity)}</span>
            <span className="why">{r.why}</span>
          </div>
        ))
      )}
      {result.wouldQueue && result.wouldQueue.length > 0 && (
        <div className="previewQueued">
          <div className="t">
            Would queue {result.wouldQueue.length} action{result.wouldQueue.length === 1 ? '' : 's'} for your approval
          </div>
          {result.wouldQueue.map((q, i) => (
            <div key={i} className="previewRow">
              <span className="t">{q.summary}</span>
              <span className="why mono">{q.tool}</span>
            </div>
          ))}
        </div>
      )}
      <div className="foot">These were not created{result.wouldQueue?.length ? ', and nothing was sent' : ''}. The real run files them once the job exists.</div>
    </div>
  )
}

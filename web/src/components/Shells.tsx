/**
 * Background shells in a chat:
 *
 *   ShellDock   above the composer: the AgentDock's sibling. A background
 *               shell's Bash call returned at once and the turn may be long
 *               over, so this is the one place that says one is still going.
 *   ShellTail   the end of its output, read off the file it writes to and
 *               polled while it runs (the CLI streams none of it to us).
 */
import { ChevronRight, Square, SquareTerminal } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ShellOutputResponse } from '../../../shared/protocol.js'
import { shellElapsedMs, shellLabel, type ShellRun } from '../../../core/shells/fold.js'
import { formatDuration } from '../transcript.js'
import { useNow } from './Agents.js'

const POLL_MS = 1500
/** A screenful: enough to see a test run's progress or a build's last error. */
const TAIL_LINES = 40
// Colour and cursor escapes: what npm, vitest and friends sprinkle on a terminal.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g

function useShellOutput(sessionId: string, run: ShellRun) {
  const [out, setOut] = useState<ShellOutputResponse | null>(null)
  const running = run.state === 'running'
  useEffect(() => {
    let stop = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/shells/${encodeURIComponent(run.toolUseId)}/output`)
        const body = (await r.json()) as ShellOutputResponse
        if (!stop) setOut(body)
      } catch {
        // The daemon restarting; the next tick tries again.
      }
      if (!stop && running) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [sessionId, run.toolUseId, running])
  return out
}

/** The last lines a background shell wrote, live while it runs, read once after. */
export function ShellTail({ sessionId, run }: { sessionId: string; run: ShellRun }) {
  const out = useShellOutput(sessionId, run)
  const ref = useRef<HTMLPreElement>(null)
  // Follow the end as it grows, the way a terminal does.
  useLayoutEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [out])
  if (!out) return <pre className="well shellTail quiet">…</pre>
  if (!out.ok) return <pre className="well shellTail quiet">{out.error}</pre>
  // A carriage return redraws its line (progress bars): keep what was drawn last.
  const lines = out.text
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.slice(l.lastIndexOf('\r') + 1))
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  const shown = lines.slice(-TAIL_LINES)
  if (!shown.length) return <pre className="well shellTail quiet">{run.state === 'running' ? 'no output yet' : '(no output)'}</pre>
  return (
    <pre ref={ref} className="well shellTail">
      {(out.truncated || lines.length > shown.length) && (
        <span className="stCut">
          … earlier output in {run.outputFile}
          {'\n'}
        </span>
      )}
      {shown.join('\n')}
    </pre>
  )
}

export function ShellDock({
  sessionId,
  shells,
  onStop,
}: {
  sessionId: string
  shells: readonly ShellRun[]
  onStop: (run: ShellRun) => void
}) {
  const live = shells.filter((s) => s.background && s.state === 'running')
  const now = useNow(live.length > 0)
  const [open, setOpen] = useState<string | null>(null)
  if (!live.length) return null
  return (
    <div className="agentDock shellDock" role="region" aria-label="Background shells">
      <div className="adHead">
        <span className="dot live" aria-hidden="true" />
        <span>
          {live.length} {live.length === 1 ? 'shell' : 'shells'} running in the background
        </span>
        <span className="sp" />
        {live.length > 1 && (
          <button type="button" className="btn xs ghost" onClick={() => live.forEach(onStop)} title="Stop every background shell">
            Stop all
          </button>
        )}
      </div>
      {live.map((s) => (
        <div key={s.toolUseId} className="sdShell">
          <div className="adRow">
            <button
              type="button"
              className="adOpen"
              title={`$ ${s.command}`}
              aria-expanded={open === s.toolUseId}
              disabled={!s.outputFile}
              onClick={() => setOpen((o) => (o === s.toolUseId ? null : s.toolUseId))}
            >
              <SquareTerminal size={12} className="sdMark" aria-hidden="true" />
              <span className="adName">{shellLabel(s)}</span>
              <span className="adNow mono">{s.description ? s.command : ''}</span>
              <span className="adTime">{formatDuration(shellElapsedMs(s, now) ?? 0)}</span>
              {s.outputFile && <ChevronRight size={11} className="chev" aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="adStop"
              disabled={!s.taskId}
              onClick={() => onStop(s)}
              title="Stop this shell"
              aria-label={`Stop ${shellLabel(s)}`}
            >
              <Square size={9} aria-hidden="true" />
            </button>
          </div>
          {open === s.toolUseId && <ShellTail sessionId={sessionId} run={s} />}
        </div>
      ))}
    </div>
  )
}

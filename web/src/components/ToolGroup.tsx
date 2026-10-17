import { Check, ChevronRight, Loader, Square, X } from 'lucide-react'
import { memo, useState } from 'react'
import { shellElapsedMs } from '../../../core/shells/fold.js'
import { formatDuration, toolLine, toolResultNote, toolsDuration, truncate, type ToolItem, type TranscriptItem } from '../transcript.js'
import { useNow } from './Agents.js'
import { ShellTail } from './Shells.js'

type Group = Extract<TranscriptItem, { kind: 'toolGroup' }>
/** `bg`: the call returned, its shell runs on in the background. */
type State = 'busy' | 'bg' | 'ok' | 'fail' | 'stopped'

/** A background shell's call returns at once, so how it went is the shell's to say. */
function stateOf(t: ToolItem): State {
  if (!t.result) return 'busy'
  const sh = t.shell
  if (sh?.background) {
    if (sh.state === 'running') return 'bg'
    if (sh.state === 'failed') return 'fail'
    if (sh.state === 'stopped' || sh.state === 'interrupted') return 'stopped'
    return 'ok'
  }
  return t.result.isError ? 'fail' : 'ok'
}

const GLYPH_LABEL: Record<State, string> = { busy: 'running', bg: 'running in background', ok: 'ok', fail: 'failed', stopped: 'stopped' }

function Glyph({ state, size }: { state: State; size: number }) {
  return (
    <span className={`glyph ${state}`} aria-label={GLYPH_LABEL[state]}>
      {state === 'busy' || state === 'bg' ? (
        <Loader size={size} aria-hidden="true" />
      ) : state === 'ok' ? (
        <Check size={size} aria-hidden="true" />
      ) : state === 'stopped' ? (
        <Square size={size - 2} aria-hidden="true" />
      ) : (
        <X size={size} aria-hidden="true" />
      )}
    </span>
  )
}

const commandOf = (t: ToolItem): string | null => (typeof t.input.command === 'string' ? `$ ${t.input.command}` : null)

/** How long a call has been out, or its background shell has been running. */
const elapsed = (t: ToolItem, now: number): string => {
  const ms = t.shell?.background ? shellElapsedMs(t.shell, now) : t.startedAt !== undefined ? now - t.startedAt : undefined
  return ms !== undefined ? formatDuration(ms) : ''
}

/** A background shell's call, timed to when its shell ended rather than to its receipt. */
const throughShell = (t: ToolItem): ToolItem => (t.shell?.background && t.shell.endedAt !== undefined ? { ...t, endedAt: t.shell.endedAt } : t)

/** How a background shell ended, in a word or two. */
function shellNote(t: ToolItem): string {
  const sh = t.shell
  if (!sh?.background) return ''
  if (sh.state === 'running') return 'in background'
  const how = sh.state === 'done' ? 'done' : sh.state === 'failed' ? (sh.exitCode !== undefined ? `exit ${sh.exitCode}` : 'failed') : sh.state
  const ms = shellElapsedMs(sh, 0)
  return [how, ms !== undefined ? formatDuration(ms) : ''].filter(Boolean).join(' · ')
}

/** What a call is doing, in words: Bash's own `description`, else tool + target. */
function label(t: ToolItem): string {
  if (t.name === 'Bash' && typeof t.input.description === 'string' && t.input.description) return t.input.description
  const l = toolLine(t.name, t.input)
  return [l.verb, l.target, l.server && `· ${l.server}`].filter(Boolean).join(' ')
}

/**
 * A run of tool calls as one pill, sized to its text so it reads as an aside
 * between sentences. It says what the run set out to do (its first call), how
 * many steps it took and how long. The label holds still while calls stream in;
 * only the step count moves, so the pill doesn't change width under the
 * reader. A failed call opens it, since that one needs reading.
 *
 * While a call is out the pill keeps a clock on it, and names it when it isn't
 * the first. A five-minute test run should look like one, not like a hang. A
 * shell left running in the background keeps the pill live until it settles.
 */
export const ToolGroup = memo(function ToolGroup({ sessionId, item }: { sessionId: string; item: Group }) {
  const tools = item.members.filter((m): m is ToolItem => m.kind === 'tool')
  const states = tools.map(stateOf)
  const pending = tools.find((t) => !t.result)
  const shells = tools.filter((_, i) => states[i] === 'bg')
  const now = useNow(!!pending || shells.length > 0)
  const failed = states.filter((s) => s === 'fail').length
  const state: State = pending ? 'busy' : shells.length ? 'bg' : failed ? 'fail' : 'ok'
  const steps = `${tools.length} ${tools.length === 1 ? 'step' : 'steps'}`
  const count = pending
    ? [tools.length > 1 ? `step ${tools.length}` : '', elapsed(pending, now)].filter(Boolean).join(' · ') || `step ${tools.length}`
    : [
        tools.length > 1 || failed ? steps : '',
        failed ? `${failed} failed` : '',
        shells.length
          ? `${shells.length > 1 ? `${shells.length} ` : ''}in background · ${elapsed(shells[0], now)}`
          : toolsDuration(tools.map(throughShell)),
      ]
        .filter(Boolean)
        .join(' · ')
  // A closed pill's lines are still mounted; only an open one reads shell output.
  const [opened, setOpened] = useState(failed > 0)
  // The call the clock is on, when the label (the first call) doesn't already say it.
  const live = pending ?? shells[0]
  const doing = live && live !== tools[0] ? label(live) : ''

  return (
    <details className={`toolGroup ${state}`} open={failed > 0} onToggle={(e) => setOpened(e.currentTarget.open)}>
      <summary title={live ? commandOf(live) ?? undefined : undefined}>
        <Glyph state={state} size={11} />
        <span className="tgLabel">{label(tools[0])}</span>
        {doing && <span className="tgNow">{doing}</span>}
        {count && <span className="tgCount mono">{count}</span>}
        <ChevronRight size={11} className="chev" aria-hidden="true" />
      </summary>
      <div className="tgBody">
        {item.members.map((m) =>
          m.kind === 'tool' ? (
            <ToolLine key={m.key} sessionId={sessionId} item={m} open={tools.length === 1} visible={opened} />
          ) : (
            <div key={m.key} className="msg thinking">
              {m.text}
            </div>
          ),
        )}
      </div>
    </details>
  )
})

/**
 * One call inside a group: a flat line that opens to the raw input and output.
 * A background shell's output is the tail of its file, not the receipt its call returned.
 */
function ToolLine({ sessionId, item, open, visible }: { sessionId: string; item: ToolItem; open: boolean; visible: boolean }) {
  const [shown, setShown] = useState(open)
  const l = toolLine(item.name, item.input)
  const state = stateOf(item)
  const now = useNow(state === 'busy' || state === 'bg')
  const note = item.shell?.background
    ? [shellNote(item), state === 'bg' ? elapsed(item, now) : ''].filter(Boolean).join(' · ')
    : state === 'busy'
      ? elapsed(item, now)
      : [toolResultNote(item), toolsDuration([item])].filter(Boolean).join(' · ')
  const command = commandOf(item)
  return (
    <details className="tline" open={open} onToggle={(e) => setShown(e.currentTarget.open)}>
      <summary>
        <Glyph state={state} size={12} />
        <span className="tlVerb">{l.verb}</span>
        <span className="tlTarget mono" title={item.name === 'Bash' ? command ?? undefined : undefined}>
          {item.name === 'Bash' ? label(item) : l.target}
          {l.server && <span className="tlServer"> · {l.server}</span>}
        </span>
        {note && <span className={`tlNote mono${state === 'fail' ? ' fail' : ''}`}>{note}</span>}
      </summary>
      <pre className="well">{truncate(command ?? JSON.stringify(item.input, null, 2), 2000)}</pre>
      {item.shell?.background && item.shell.outputFile ? (
        visible && shown && <ShellTail sessionId={sessionId} run={item.shell} />
      ) : (
        item.result && (
          <pre className={`well result${state === 'fail' ? ' fail' : ''}`}>{truncate(item.result.text || '(no output)', 2000)}</pre>
        )
      )}
    </details>
  )
}

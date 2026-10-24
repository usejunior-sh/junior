/**
 * File rewind for chats, the pure part (server/session/rewind-ops.ts runs it).
 * A Claude chat keeps a copy of each file before a turn edits it, keyed by
 * the user message that started the turn. Rewinding puts the files back to
 * how they were before that message; the conversation stays as it is.
 *
 * What lives here: which sessions may rewind and when, finding the message in
 * the log, the agent's answer as the wire's RewindResult, and the words the
 * transcript and the agent get afterwards. No I/O, so it is unit-tested.
 */
import path from 'node:path'
import type { RewindResult, SessionEvent, SessionKind } from '../../shared/protocol.js'

/** What decides whether a rewind may run at all. */
export type RewindGate = {
  /** the chat still exists */
  exists: boolean
  /** its agent keeps file checkpoints (the `fileCheckpoints` capability) */
  checkpoints: boolean
  /** the agent's name, for "not supported on Codex" */
  agentLabel: string
  kind: SessionKind
  dryRun: boolean
  /** a turn is open, a prompt waits, or a Workflow run is still editing */
  busy: boolean
  /** the chat's next message starts a fresh agent session, so its old checkpoints are out of reach */
  freshNext: boolean
}

/** Why this rewind can't run, or null when it may. Every refusal changes nothing on disk. */
export function rewindRefusal(g: RewindGate): string | null {
  if (!g.exists) return 'That chat is gone.'
  if (!g.checkpoints) return `File rewind isn't supported on ${g.agentLabel} chats.`
  if (g.kind !== 'chat') return 'Only chats keep file checkpoints.'
  if (g.freshNext) return 'This chat starts fresh on its next message. Its old checkpoints are out of reach.'
  // Looking is always safe. Putting files back under a running turn is not.
  if (!g.dryRun && g.busy) return 'Junior is still working in this chat. Stop it first, then rewind.'
  return null
}

/** The user message a rewind goes back to: the `local_user` event that carries `messageId`. */
export type RewindTarget = { text: string; seq?: number }

/** Find `messageId` in a chat's log. Null = not one of this chat's checkpointed messages. */
export function findRewindTarget(events: ReadonlyArray<SessionEvent | { seq: number; event: SessionEvent }>, messageId: string): RewindTarget | null {
  for (const e of events) {
    const ev = 'event' in e ? e.event : e
    if (ev.kind === 'local_user' && ev.messageId === messageId) return { text: ev.text, ...('event' in e ? { seq: e.seq } : {}) }
  }
  return null
}

/** The SDK's RewindFilesResult, as the agent hands it back. */
export type AgentRewind = {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
  skippedLinks?: number
}

const count = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined)

/** The agent's answer as the wire's RewindResult. Only the fields the agent set are kept. */
export function toRewindResult(req: { sessionId: string; messageId: string; dryRun: boolean }, out: AgentRewind): RewindResult {
  const files = Array.isArray(out.filesChanged) ? out.filesChanged.filter((f): f is string => typeof f === 'string') : undefined
  const ins = count(out.insertions)
  const del = count(out.deletions)
  const skipped = count(out.skippedLinks)
  return {
    sessionId: req.sessionId,
    messageId: req.messageId,
    dryRun: req.dryRun,
    ok: out.canRewind === true,
    ...(out.canRewind !== true ? { error: out.error?.trim() || 'Junior could not rewind these files.' } : {}),
    ...(files ? { filesChanged: files } : {}),
    ...(ins !== undefined ? { insertions: ins } : {}),
    ...(del !== undefined ? { deletions: del } : {}),
    ...(skipped ? { skippedLinks: skipped } : {}),
  }
}

/** A refusal as the wire's RewindResult: nothing ran. */
export const refusedRewind = (req: { sessionId: string; messageId: string; dryRun: boolean }, error: string): RewindResult => ({
  sessionId: req.sessionId,
  messageId: req.messageId,
  dryRun: req.dryRun,
  ok: false,
  error,
})

/** A message as a short quote: one line, at most `max` characters. */
export function quoteOf(text: string, max = 48): string {
  const one = text.replace(/\s+/g, ' ').trim()
  if (!one) return 'your message'
  return `“${one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one}”`
}

/** Paths as the user knows them: relative to the chat's folder when inside it. */
export function shownPaths(files: readonly string[], cwd: string, max = 4): string {
  const rel = files.map((f) => {
    const r = path.relative(cwd, path.resolve(cwd, f))
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : f
  })
  const head = rel.slice(0, max).join(', ')
  return rel.length > max ? `${head} and ${rel.length - max} more` : head
}

/** The transcript's line after a real rewind. `files` is what the dry run before it listed. */
export function rewindNotice(target: RewindTarget, files: readonly string[], cwd: string, skippedLinks = 0): string {
  const to = `Files rewound to before ${quoteOf(target.text)}.`
  const what = files.length === 0 ? ' Nothing needed changing.' : ` ${files.length === 1 ? '1 file' : `${files.length} files`} put back: ${shownPaths(files, cwd)}.`
  const skipped = skippedLinks > 0 ? ` ${skippedLinks === 1 ? '1 linked file was' : `${skippedLinks} linked files were`} left alone.` : ''
  return `${to}${what}${skipped}`
}

/**
 * What the agent is told with the next message after a real rewind. Its own
 * history still says it made those edits, so without this it would build on
 * files that are no longer there.
 */
export function agentRewindNote(target: RewindTarget, files: readonly string[], cwd: string): string {
  const list = files.length ? ` Files put back: ${shownPaths(files, cwd, 20)}.` : ''
  return `Note from Junior: the user rewound the files to how they were before their message ${quoteOf(target.text, 120)}. Edits made since then to those files are gone.${list} Read a file again before you change it.`
}

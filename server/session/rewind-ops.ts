/**
 * rewind_files: put a chat's files back to how they were before one of its
 * messages, through the agent's own file checkpoints (Query.rewindFiles,
 * spawned with enableFileCheckpointing). The rules and the words are in
 * core/sessions/rewind.ts; this file asks the agent and records the result.
 *
 * A dry run only asks the agent what would change: it never calls the real
 * rewind. A real rewind runs a dry run first, both to refuse early and to
 * name the files (the agent's real answer leaves the list out), then writes
 * one line into the transcript and tells the agent with the next message.
 * Local work only: nothing here leaves the machine.
 */
import type { RewindResult } from '../../shared/protocol.js'
import { agentRewindNote, refusedRewind, rewindNotice, rewindRefusal, toRewindResult, findRewindTarget } from '../../core/sessions/rewind.js'
import { providerFor } from '../providers/registry.js'
import type { WorkspaceRuntime } from '../workspace/runtime.js'
import type { LiveSession } from './live-session.js'
import { broadcast } from '../ws/send.js'
import { errText } from '../errors.js'
import { log } from '../log.js'

export type RewindRequest = { sessionId: string; messageId: string; dryRun: boolean }

/** How a session with no subprocess gets one: getOrRevive, passed in so a test can stand one up. */
export type Revive = (rt: WorkspaceRuntime, sessionId: string) => Promise<LiveSession | null>

/** The parts of a live session a rewind uses. */
type Rewindable = Pick<LiveSession, 'busy' | 'checkpoints' | 'rewindFiles' | 'notice' | 'noteRewound'>

/** Chats with a rewind in flight, per workspace: a second one waits its turn by being refused. */
const inFlight = new Set<string>()

/** One call to the agent, as the wire's result. A refusal from the agent (a throw) changes nothing. */
async function ask(session: Rewindable, req: RewindRequest, dryRun: boolean): Promise<RewindResult> {
  const asked = { ...req, dryRun }
  try {
    return toRewindResult(asked, await session.rewindFiles(req.messageId, dryRun))
  } catch (err) {
    return refusedRewind(asked, errText(err) || 'Junior could not rewind these files.')
  }
}

export async function rewindFilesOp(rt: WorkspaceRuntime, req: RewindRequest, revive: Revive): Promise<RewindResult> {
  const row = rt.rows.get(req.sessionId)
  const provider = row ? providerFor(row.provider) : null
  const live = rt.live.get(req.sessionId)
  const refusal = rewindRefusal({
    exists: !!row,
    checkpoints: provider?.capabilities.fileCheckpoints === true,
    agentLabel: provider?.label ?? 'this agent',
    kind: row?.kind ?? 'chat',
    dryRun: req.dryRun,
    busy: !!live?.busy,
    // A live subprocess still has its checkpoints; a revival would start a fresh agent session without them.
    freshNext: !live && rt.freshNext.has(req.sessionId),
  })
  if (refusal || !row) return refusedRewind(req, refusal ?? 'That chat is gone.')

  const target = findRewindTarget(await rt.store.events.read(row.id), req.messageId)
  if (!target) return refusedRewind(req, 'That message has no file checkpoint. Messages sent before checkpoints came in have none.')

  const key = `${rt.meta.id}:${row.id}`
  if (inFlight.has(key)) return refusedRewind(req, 'A rewind is already running in this chat.')
  inFlight.add(key)
  try {
    // The checkpoints live with the agent's own session: a chat with no subprocess is revived (resumed) to reach them.
    const session: Rewindable | null = live ?? (await revive(rt, row.id))
    if (!session) return refusedRewind(req, "This chat can't start right now, so its files can't be rewound.")
    if (!session.checkpoints) return refusedRewind(req, "This chat doesn't keep file checkpoints.")

    const preview = await ask(session, req, true)
    if (req.dryRun || !preview.ok) return { ...preview, dryRun: req.dryRun }

    // Checked again: a message may have started a turn while the preview ran.
    if (session.busy) return refusedRewind(req, 'Junior is still working in this chat. Stop it first, then rewind.')
    const done = await ask(session, req, false)
    if (!done.ok) return done

    const files = preview.filesChanged ?? []
    const result: RewindResult = {
      ...done,
      filesChanged: files,
      ...(preview.insertions !== undefined ? { insertions: preview.insertions } : {}),
      ...(preview.deletions !== undefined ? { deletions: preview.deletions } : {}),
    }
    session.notice(rewindNotice(target, files, row.cwd, done.skippedLinks ?? 0))
    session.noteRewound(agentRewindNote(target, files, row.cwd))
    // The files on disk moved: the next `@` search relists, and the changes view refetches.
    rt.files.invalidate(row.cwd)
    broadcast(rt, { type: 'session_changed', sessionId: row.id })
    log('info', 'session', `rewound ${files.length} file(s) to a checkpoint`, { session: row.id, workspace: rt.meta.id, message: req.messageId })
    return result
  } finally {
    inFlight.delete(key)
  }
}

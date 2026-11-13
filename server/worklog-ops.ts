/**
 * Junior's work log on the server (core/junior/worklog.ts):
 * `<workspace>/worklog.json`, written one change at a time per workspace.
 * A thread Junior started records each report here (session/thread-report.ts);
 * Junior's chat reads the recent lines at spawn and the rest with
 * read_work_log. Local only: nothing here leaves the machine.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { noteWork, parseWorklog, serializeWorklog, trimWorklog, type WorklogEntry } from '../core/junior/worklog.js'
import { errText } from './errors.js'
import { log } from './log.js'
import type { WorkspaceRuntime } from './workspace/runtime.js'
import { workspaceDir } from './workspaces.js'

/** Where a workspace keeps its work log. */
export const worklogFile = (workspaceId: string): string => path.join(workspaceDir(workspaceId), 'worklog.json')

const queues = new Map<string, Promise<unknown>>()

/** Run `fn` after every change already queued for this workspace. */
function serial<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(workspaceId) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  queues.set(
    workspaceId,
    next.catch(() => {}),
  )
  return next
}

/** Every stored entry. A missing file is an empty log; a bad row is logged and skipped. */
export async function readWorklog(workspaceId: string): Promise<WorklogEntry[]> {
  let text: string
  try {
    text = await readFile(worklogFile(workspaceId), 'utf8')
  } catch {
    return []
  }
  const { entries, errors } = parseWorklog(text)
  if (errors.length) log('warn', 'worklog', `worklog.json: ${errors.join('; ')}`, { workspace: workspaceId })
  return entries
}

async function writeWorklog(workspaceId: string, entries: readonly WorklogEntry[]): Promise<void> {
  const file = worklogFile(workspaceId)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, serializeWorklog(entries))
  await rename(tmp, file)
}

/** Record a thread's latest report. */
export async function noteWorkOp(rt: WorkspaceRuntime, entry: WorklogEntry, now = Date.now()): Promise<void> {
  await serial(rt.meta.id, async () => {
    await writeWorklog(rt.meta.id, noteWork(await readWorklog(rt.meta.id), entry, now))
  })
}

/** The log for a prompt or a tool, newest first. Never throws: a bad file must not stop a session from starting. */
export async function worklogFor(rt: WorkspaceRuntime, now = Date.now()): Promise<WorklogEntry[]> {
  try {
    return trimWorklog(await readWorklog(rt.meta.id), now)
  } catch (err) {
    log('warn', 'worklog', `could not read the work log: ${errText(err)}`, { workspace: rt.meta.id })
    return []
  }
}

/**
 * The user's context files, read at spawn (shared/juniorContext.ts composes
 * them): `<workspace>/context.md` for the whole workspace and
 * `<project>/.junior/context.md` for one project. Either may be missing; a
 * missing one adds nothing. Every session kind gets them (chats, briefs,
 * tasks, team workers, job runs), so the user says a thing once.
 */
import path from 'node:path'
import { open } from 'node:fs/promises'
import type { StoredSession } from '../core/store/types.js'
import type { SessionContextFiles } from '../shared/protocol.js'
import { composeContextFiles, CONTEXT_FILE_CAP, type ContextFileInput, type ContextLoad } from '../shared/juniorContext.js'
import { workspaceDir } from './workspaces.js'
import { log } from './log.js'
import { errText } from './errors.js'
import type { WorkspaceRuntime } from './workspace/runtime.js'

export const WORKSPACE_CONTEXT_FILE = 'context.md'
export const PROJECT_CONTEXT_FILE = path.join('.junior', 'context.md')

/** The workspace's own context file, in its folder (`~/.junior/workspaces/<id>/`). */
export const workspaceContextPath = (workspaceRoot: string) => path.join(workspaceRoot, WORKSPACE_CONTEXT_FILE)
/** A project's context file, inside the project folder. */
export const projectContextPath = (projectPath: string) => path.join(projectPath, PROJECT_CONTEXT_FILE)

/**
 * Never read more than this from one file. The composer cuts far shorter; this
 * only keeps a runaway file (a log someone saved as context.md) out of memory.
 * Generous enough that invisible characters can't push real text past it.
 */
const READ_LIMIT_BYTES = CONTEXT_FILE_CAP * 16

/** The file's start as text, or null when it doesn't exist or isn't a file. */
export async function readContextFile(file: string): Promise<string | null> {
  let fh
  try {
    fh = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) return null
    const buf = Buffer.alloc(Math.min(st.size, READ_LIMIT_BYTES))
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    // A cut through a multi-byte character decodes to one U+FFFD at the very end; the cap cuts long before it.
    return buf.subarray(0, bytesRead).toString('utf8')
  } catch (err) {
    log('warn', 'context', `could not read ${file}: ${errText(err)}`)
    return null
  } finally {
    await fh.close().catch(() => {})
  }
}

/** Read and compose both files for one workspace folder and (when there is one) one project. */
export async function loadContextFiles(workspaceRoot: string, project: { name: string; path: string } | null): Promise<ContextLoad> {
  const wsFile = workspaceContextPath(workspaceRoot)
  const pjFile = project ? projectContextPath(project.path) : null
  const [ws, pj] = await Promise.all([readContextFile(wsFile), pjFile ? readContextFile(pjFile) : Promise.resolve(null)])
  const inputs: ContextFileInput[] = []
  if (ws != null) inputs.push({ scope: 'workspace', path: wsFile, text: ws })
  if (pj != null && pjFile && project) inputs.push({ scope: 'project', path: pjFile, text: pj, label: project.name })
  return composeContextFiles(inputs)
}

/** What the session summary shows: the cost, without the text. */
export const contextCost = (load: ContextLoad): SessionContextFiles => ({ tokens: load.tokens, files: load.files })

/**
 * Load the context for a session about to spawn, in the project it runs in
 * (the stored project, never derived from `cwd`: a worktree's folder isn't
 * the project's, and the project's file is the one the user edits), and
 * remember its cost for the session summary. Never throws: a context file
 * that can't be read must not stop a session from starting.
 */
export async function contextForSession(rt: WorkspaceRuntime, row: Pick<StoredSession, 'id' | 'projectId'>): Promise<ContextLoad> {
  try {
    const project = row.projectId ? ((await rt.store.projects.list()).find((p) => p.id === row.projectId) ?? null) : null
    const load = await loadContextFiles(workspaceDir(rt.meta.id), project)
    noteSessionContext(rt, row.id, load)
    return load
  } catch (err) {
    log('warn', 'context', `could not load context files: ${errText(err)}`, { session: row.id, workspace: rt.meta.id })
    return { append: '', tokens: 0, files: [] }
  }
}

/** Record what a session loaded (or that it loaded nothing), and say so in the log when a file was cut or cleaned. */
export function noteSessionContext(rt: WorkspaceRuntime, sessionId: string, load: ContextLoad): void {
  if (load.files.length) rt.sessionContext.set(sessionId, contextCost(load))
  else rt.sessionContext.delete(sessionId)
  for (const f of load.files) {
    if (f.truncated) log('info', 'context', `${f.path} is longer than Junior loads; only its start went in`, { session: sessionId, workspace: rt.meta.id })
    if (f.stripped) log('warn', 'context', `took ${f.stripped} invisible character(s) out of ${f.path}`, { session: sessionId, workspace: rt.meta.id })
  }
}

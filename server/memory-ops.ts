/**
 * Junior's memory on the server (core/junior/memory.ts): `<workspace>/memory.md`
 * and its never-loaded `memory-archive.md`, written one change at a time per
 * workspace. Junior writes through the junior MCP (remember, forget); the user
 * edits the file by hand. Read at spawn into every chat and thread, so an edit
 * reaches the next session, not the one already going. Local only.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { appendArchive, forget, type MemoryLine, memoryLine, parseMemory, remember, type RememberResult, serializeMemory } from '../core/junior/memory.js'
import { errText } from './errors.js'
import { log } from './log.js'
import type { WorkspaceRuntime } from './workspace/runtime.js'
import { workspaceDir } from './workspaces.js'

export const memoryFile = (workspaceId: string): string => path.join(workspaceDir(workspaceId), 'memory.md')
export const memoryArchiveFile = (workspaceId: string): string => path.join(workspaceDir(workspaceId), 'memory-archive.md')

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

/** The memory lines, oldest first. A missing file is no memory. */
export async function readMemory(workspaceId: string): Promise<MemoryLine[]> {
  try {
    return parseMemory(await readFile(memoryFile(workspaceId), 'utf8'))
  } catch {
    return []
  }
}

async function writeMemory(workspaceId: string, lines: readonly MemoryLine[]): Promise<void> {
  const file = memoryFile(workspaceId)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, serializeMemory(lines))
  await rename(tmp, file)
}

/** Append lines to the archive, starting it with its header the first time. */
async function archive(workspaceId: string, lines: readonly MemoryLine[]): Promise<void> {
  if (!lines.length) return
  const file = memoryArchiveFile(workspaceId)
  const existing = await readFile(file, 'utf8').catch(() => '')
  const text = existing ? `${existing.endsWith('\n') ? '' : '\n'}${lines.map(memoryLine).join('\n')}\n` : appendArchive('', lines)
  await appendFile(file, text)
}

export async function rememberOp(rt: WorkspaceRuntime, input: { text: unknown; replaces?: unknown }, now = Date.now()): Promise<RememberResult> {
  if (typeof input.text !== 'string') throw new Error('a memory needs text')
  if (input.replaces !== undefined && typeof input.replaces !== 'string') throw new Error('replaces: the text of the line to replace')
  return serial(rt.meta.id, async () => {
    const out = remember(await readMemory(rt.meta.id), { text: input.text as string, ...(input.replaces ? { replaces: input.replaces as string } : {}) }, now)
    // Archive first: a line is never lost between the two writes, at worst it is in both.
    await archive(rt.meta.id, out.archived)
    await writeMemory(rt.meta.id, out.lines)
    return out
  })
}

export async function forgetOp(rt: WorkspaceRuntime, needle: unknown): Promise<MemoryLine> {
  if (typeof needle !== 'string' || !needle.trim()) throw new Error('forget needs the text of the line')
  return serial(rt.meta.id, async () => {
    const out = forget(await readMemory(rt.meta.id), needle)
    await writeMemory(rt.meta.id, out.lines)
    return out.forgot
  })
}

/** The lines for a prompt. Never throws: a bad file must not stop a session from starting. */
export async function memoryForPrompt(rt: WorkspaceRuntime): Promise<MemoryLine[]> {
  try {
    return await readMemory(rt.meta.id)
  } catch (err) {
    log('warn', 'memory', `could not read memory.md: ${errText(err)}`, { workspace: rt.meta.id })
    return []
  }
}

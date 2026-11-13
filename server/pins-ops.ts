/**
 * Pinned notes on the server (core/junior/pins.ts): `<workspace>/pins.json`,
 * read and written one change at a time per workspace. Junior pins through
 * the junior MCP (pin_note, list_pins, unpin); the app reads and unpins over
 * HTTP. Every change broadcasts `pins_changed`. Local only: nothing here
 * leaves the machine, so nothing is held for approval.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { activePins, addPin, parsePins, type Pin, type PinScope, removePin, serializePins } from '../core/junior/pins.js'
import { errText } from './errors.js'
import { log } from './log.js'
import type { WorkspaceRuntime } from './workspace/runtime.js'
import { workspaceDir } from './workspaces.js'
import { broadcast } from './ws/send.js'

/** Where a workspace keeps its pins. */
export const pinsFile = (workspaceId: string): string => path.join(workspaceDir(workspaceId), 'pins.json')

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

/** Every stored pin (expired ones too). A missing file is no pins; a bad row is logged and skipped. */
export async function readPins(workspaceId: string): Promise<Pin[]> {
  let text: string
  try {
    text = await readFile(pinsFile(workspaceId), 'utf8')
  } catch {
    return []
  }
  const { pins, errors } = parsePins(text)
  if (errors.length) log('warn', 'pins', `pins.json: ${errors.join('; ')}`, { workspace: workspaceId })
  return pins
}

async function writePins(workspaceId: string, pins: readonly Pin[]): Promise<void> {
  const file = pinsFile(workspaceId)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, serializePins(pins))
  await rename(tmp, file)
}

const changed = (rt: WorkspaceRuntime) => broadcast(rt, { type: 'pins_changed' })

/** The pins that hold now, oldest first. */
export async function listPinsOp(rt: WorkspaceRuntime, now = Date.now()): Promise<Pin[]> {
  return activePins(await readPins(rt.meta.id), now)
}

/** Pin a note. The same words twice keep one pin. */
export async function pinNoteOp(rt: WorkspaceRuntime, input: { text: unknown; scope?: unknown }, now = Date.now()): Promise<{ pin: Pin; existed: boolean }> {
  if (typeof input.text !== 'string') throw new Error('a pin needs text')
  if (input.scope !== undefined && input.scope !== 'today' && input.scope !== 'always') throw new Error('scope: today or always')
  const r = await serial(rt.meta.id, async () => {
    const out = addPin(await readPins(rt.meta.id), { text: input.text as string, ...(input.scope ? { scope: input.scope as PinScope } : {}) }, now)
    await writePins(rt.meta.id, out.pins)
    return out
  })
  changed(rt)
  return { pin: r.pin, existed: r.existed }
}

/** Take a pin off by id. */
export async function unpinOp(rt: WorkspaceRuntime, id: unknown): Promise<Pin> {
  if (typeof id !== 'string' || !id.trim()) throw new Error('unpin needs an id')
  const pin = await serial(rt.meta.id, async () => {
    const out = removePin(await readPins(rt.meta.id), id.trim())
    await writePins(rt.meta.id, out.pins)
    return out.pin
  })
  changed(rt)
  return pin
}

/** The active pins for a prompt. Never throws: a bad pins file must not stop a session from starting. */
export async function pinsForPrompt(rt: WorkspaceRuntime, now = Date.now()): Promise<Pin[]> {
  try {
    return await listPinsOp(rt, now)
  } catch (err) {
    log('warn', 'pins', `could not read pins: ${errText(err)}`, { workspace: rt.meta.id })
    return []
  }
}

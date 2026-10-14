/**
 * The tail of a background shell's output, for the chat's dock and Bash line.
 * The CLI never streams a shell's output to us; a background one writes it to
 * a file under its tasks folder, and this reads the end of that file.
 *
 * The path comes only from the session's own event log, through the same fold
 * the UI uses (core/shells/fold.ts), which believes a path only when it names
 * the task the CLI started for that call — never from the request. Found paths
 * are kept, so polling doesn't re-read the log.
 */
import { open } from 'node:fs/promises'
import { buildShells } from '../core/shells/fold.js'
import type { StoredEvent } from '../core/store/types.js'
import type { ShellOutputResponse } from '../shared/protocol.js'

/** Enough for the last screenful or so of a test run or a build. */
export const SHELL_TAIL_BYTES = 16 * 1024

const paths = new Map<string, string>()

export async function shellOutput(
  readEvents: (sessionId: string) => Promise<StoredEvent[]>,
  sessionId: string,
  toolUseId: string,
): Promise<ShellOutputResponse> {
  const key = `${sessionId}\0${toolUseId}`
  let file = paths.get(key)
  if (!file) {
    const events = await readEvents(sessionId)
    const run = buildShells(events.map((e) => e.event)).find((r) => r.toolUseId === toolUseId)
    if (!run) return { ok: false, error: 'no such shell in this session' }
    if (!run.outputFile) return { ok: false, error: 'this shell has no output file' }
    file = run.outputFile
    paths.set(key, file)
  }
  let fh
  try {
    fh = await open(file, 'r')
  } catch {
    // The CLI's tasks folder is temporary; an old shell's output is often gone.
    return { ok: false, error: 'the output file is gone' }
  }
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - SHELL_TAIL_BYTES)
    const buf = Buffer.alloc(size - start)
    await fh.read(buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    // Cut back to a whole line, so a cut doesn't start mid-character or mid-word.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return { ok: true, text, bytes: size, truncated: start > 0 }
  } finally {
    await fh.close()
  }
}

/**
 * `from:` on write_artifact / update_artifact: a file the session made, which
 * triage copies into the artifacts folder. The model names the path and triage
 * copies it somewhere an HTTP route serves, so this is a file-exfiltration
 * surface and is narrow on purpose:
 *
 *   - a regular file whose realpath sits under the session's folder, a
 *     checkout of its project, the temp folder, the workspace's attachments or
 *     its browser evidence. With no session (an external MCP client) only the
 *     temp folders count;
 *   - never a file inside the artifacts folder itself;
 *   - its extension names one of the formats, the same one the caller declared;
 *   - at most 25 MB, and the bytes must look like the format (magic bytes).
 *
 * The copy is a snapshot: later edits to the original do not change the artifact.
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ARTIFACT_FORMATS, ARTIFACT_MAX_BYTES, type ArtifactFormat, formatOfExt, sniffFormat } from '../shared/protocol.js'
import { openableFile } from './editors.js'
import { workspaceDir } from './workspaces.js'
import type { WorkspaceRuntime } from './workspace/runtime.js'

const OUTSIDE = "from: must be a file in this session's project folder or the temp folder"

/**
 * The temp folders. On a Mac `os.tmpdir()` is /var/folders/…, but scripts and
 * Junior write to /tmp, so that counts too (and /var/tmp). Roots are compared by realpath.
 */
export const tempRoots = (): string[] => [...new Set([os.tmpdir(), '/tmp', '/var/tmp'])]

/** Where a session's `from:` may read. Without a session, only the temp folders. */
export function sourceRoots(rt: WorkspaceRuntime, sessionId: string | undefined): string[] {
  const roots = tempRoots()
  const row = sessionId ? rt.rows.get(sessionId) : undefined
  if (!row) return roots
  const checkouts = rt.checkouts ? [...rt.checkouts.values()] : []
  const projectId = row.projectId ?? (row.checkoutId ? rt.checkouts?.get(row.checkoutId)?.projectId : undefined)
  const mine = projectId ? checkouts.filter((c) => c.projectId === projectId && c.state === 'active').map((c) => c.path) : []
  return [...roots, row.cwd, ...mine, rt.attachmentsDir, path.join(workspaceDir(rt.meta.id), 'browser')]
}

export async function resolveSource(
  rt: WorkspaceRuntime,
  sessionId: string | undefined,
  file: string,
  declared: ArtifactFormat | undefined,
): Promise<{ bytes: Buffer; format: ArtifactFormat; name: string }> {
  if (!path.isAbsolute(file)) throw new Error('from: needs an absolute path')
  const row = sessionId ? rt.rows.get(sessionId) : undefined
  const real = await openableFile(file, row?.cwd ?? os.tmpdir(), sourceRoots(rt, sessionId), OUTSIDE)
  const artifactsRoot = await realpath(rt.artifacts.root).catch(() => path.resolve(rt.artifacts.root))
  if (real === artifactsRoot || real.startsWith(artifactsRoot + path.sep)) {
    throw new Error('from: cannot be a file inside the artifacts folder; update the artifact by id instead')
  }
  const byExt = formatOfExt(path.extname(file))
  if (!byExt) throw new Error(`from: .${path.extname(file).slice(1) || '(none)'} is not a file type triage publishes (${ARTIFACT_FORMATS.join(', ')})`)
  if (declared && declared !== byExt) throw new Error(`from: the file is .${path.extname(file).slice(1)} but the format is ${declared}`)
  const st = await stat(real)
  if (st.size > ARTIFACT_MAX_BYTES) throw new Error(`${Math.ceil(st.size / 104857.6) / 10} MB is over the 25 MB limit for an artifact`)
  const bytes = await readFile(real)
  const why = sniffFormat(byExt, bytes)
  if (why) throw new Error(`from: ${why}`)
  return { bytes, format: byExt, name: path.basename(file) }
}

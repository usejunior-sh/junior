import http from 'node:http'
import { defaultRuntime, runtimes, WorkspaceRuntime } from '../workspace/runtime.js'

/**
 * A form's worth of JSON. Routes that carry base64 screenshots pass a bigger
 * `limit` (bytes). A single macOS screenshot blows past 1MB once base64'd, and
 * a body that dies mid-upload reads to the user as "the network broke".
 * Past the limit the request is destroyed, so an endless body can't keep
 * filling memory after the promise has already given up.
 */
export function readJsonBody(req: http.IncomingMessage, limit = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (err: unknown) => {
      if (settled) return
      settled = true
      chunks.length = 0
      reject(err)
    }
    req.on('data', (chunk: Buffer | string) => {
      if (settled) return
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      size += buf.length
      if (size > limit) {
        fail(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(buf)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      // decode once at the end: a multi-byte character can straddle two chunks
      const data = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(data ? JSON.parse(data) : null)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', fail)
  })
}

/**
 * Which workspace a request belongs to: the ?workspace= param wins (explicit,
 * the MCP shim and scripts use it), then the junior_ws cookie (how the SPA
 * rides: cookies travel on every fetch and on the WS upgrade with zero
 * call-site churn), then the default. A stale id falls back to the default
 * rather than erroring. A deleted workspace must not brick the UI.
 */
function cookieWorkspace(req: http.IncomingMessage): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === 'junior_ws') return decodeURIComponent(v.join('='))
  }
  return undefined
}

export function resolveRuntime(req: http.IncomingMessage, url: URL): WorkspaceRuntime {
  const qid = url.searchParams.get('workspace')
  if (qid) {
    const rt = runtimes.get(qid)
    if (rt) return rt
  }
  const cid = cookieWorkspace(req)
  if (cid) {
    const rt = runtimes.get(cid)
    if (rt) return rt
  }
  return defaultRuntime()
}

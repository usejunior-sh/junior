import http from 'node:http'
import { defaultRuntime, runtimes, WorkspaceRuntime } from '../workspace/runtime.js'

/**
 * A form's worth of JSON. Routes that carry base64 screenshots pass a bigger
 * `limit` — a single macOS screenshot blows past 1MB once base64'd, and a
 * body that dies mid-upload reads to the user as "the network broke".
 */
export function readJsonBody(req: http.IncomingMessage, limit = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > limit) reject(new Error('body too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : null)
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Which workspace a request belongs to: the ?workspace= param wins (explicit —
 * the MCP shim and scripts use it), then the triage_ws cookie (how the SPA
 * rides: cookies travel on every fetch and on the WS upgrade with zero
 * call-site churn), then the default. A stale id falls back to the default
 * rather than erroring — a deleted workspace must not brick the UI.
 */
function cookieWorkspace(req: http.IncomingMessage): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === 'triage_ws') return decodeURIComponent(v.join('='))
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

import { callTool as callMcpTool, PROTOCOL_VERSION as MCP_PROTOCOL_VERSION, TOOLS as MCP_TOOLS } from '../core/mcp/tools.js'
import { TRIAGE_MCP_INSTRUCTIONS } from '../shared/triageContext.js'
import { PORT, VERSION } from './config.js'
import { errText } from './errors.js'

/**
 * The MCP endpoint (streamable HTTP): the same contract the stdio shim serves
 * (core/mcp/tools.ts), reachable as a URL instead of a spawned process,
 * `http://localhost:5178/mcp` for a running daemon, `…:5188/mcp` in dev. No
 * per-session subprocess to spawn, resolve on PATH, or lose a connect race
 * with, which is most of what made MCP feel unreliable from outside triage.
 *
 * The workspace rides in the URL (`?workspace=<id>`), not an env var, and an
 * id that matches nothing is refused at `initialize`. The client shows the
 * server as failed instead of quietly filing work into the default inbox.
 */
export const MCP_PATH = '/mcp'

/** Loopback into this daemon's own API, so one route table serves every door. */
function mcpApi(workspace: string | null): (path: string, body?: unknown, method?: string) => Promise<unknown> {
  return async (path, body, method) => {
    if (workspace) path += `${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(workspace)}`
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return (await res.json()) as unknown
  }
}

export type McpRpc = { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> }

/** One JSON-RPC message. Returns null for a notification (nothing to send back). */
export async function mcpDispatch(msg: McpRpc, workspace: string | null, serverUrl: string): Promise<unknown | null> {
  const id = msg.id
  const ok = (result: unknown) => (id === undefined ? null : { jsonrpc: '2.0', id, result })
  const fail = (code: number, message: string) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } })
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'triage', version: VERSION },
        instructions: TRIAGE_MCP_INSTRUCTIONS,
      })
    case 'ping':
      return ok({})
    case 'tools/list':
      return ok({ tools: MCP_TOOLS })
    case 'tools/call': {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      try {
        const { text, isError } = await callMcpTool(mcpApi(workspace), { serverUrl, requestedWorkspace: workspace }, name, args)
        return ok({ content: [{ type: 'text', text }], isError })
      } catch (err) {
        return ok({ content: [{ type: 'text', text: `failed: ${errText(err)}` }], isError: true })
      }
    }
    default:
      return msg.method ? fail(-32601, `method not found: ${msg.method}`) : fail(-32600, 'invalid request')
  }
}

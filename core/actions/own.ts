/**
 * Junior's own servers: the in-process MCP servers a session registers to
 * write this machine's inbox, run a team or a task, drive the pane. A call to
 * one is a hand-in or a local write, never a send. Pure and browser-safe.
 *
 * A name alone proves nothing: a user can configure a stdio server called
 * `browser`, `task` or `junior`. A server counts as Junior's own only when the
 * session registered it in-process (an SDK server with a live instance, which
 * no config file can produce) under one of these names.
 */
export const OWN_SERVER_NAMES: ReadonlySet<string> = new Set(['junior', 'team', 'task', 'goal', 'gate', 'brief', 'browser'])

/** No own servers: the safe default, every MCP call is sorted on its merits. */
export const NO_OWN_SERVERS: ReadonlySet<string> = new Set()

/** `mcp__<server>__<leaf>` → the server segment. */
export const serverOf = (toolName: string): string => {
  const rest = toolName.slice('mcp__'.length)
  const cut = rest.lastIndexOf('__')
  return cut === -1 ? rest : rest.slice(0, cut)
}

/** An SDK server built in this process: `type: 'sdk'` with a live instance (it has methods; parsed JSON never does). */
const inProcess = (cfg: unknown): boolean => {
  if (!cfg || typeof cfg !== 'object') return false
  const c = cfg as { type?: unknown; instance?: unknown }
  if (c.type !== 'sdk' || !c.instance || typeof c.instance !== 'object') return false
  return typeof (c.instance as { connect?: unknown }).connect === 'function'
}

/** The servers a session registered in-process under one of Junior's names: the only ones that count as its own. */
export function ownServersOf(servers: Readonly<Record<string, unknown>> | undefined): ReadonlySet<string> {
  const own = new Set<string>()
  for (const [name, cfg] of Object.entries(servers ?? {})) if (OWN_SERVER_NAMES.has(name) && inProcess(cfg)) own.add(name)
  return own
}

/** A call to one of the session's own servers (`own` from ownServersOf). */
export const isOwnTool = (toolName: string, own: ReadonlySet<string>): boolean => toolName.startsWith('mcp__') && own.has(serverOf(toolName))

/**
 * A stored record of a hand-in to one of Junior's own servers: an attempt
 * the tracker kept by name, from before every own server was listed here.
 * Never a send. A held call (it has a queue) is a real send, whatever its
 * server is called: the hold sorted it against the session's real servers.
 */
export const isOwnHandIn = (a: { tool: string; queue?: unknown }): boolean =>
  !a.queue && a.tool.startsWith('mcp__') && OWN_SERVER_NAMES.has(serverOf(a.tool))

/**
 * Junior's own in-process servers: they write this machine's inbox, run a
 * team or a task, drive the pane. A call to one is a hand-in or a local
 * write, never a send. Pure and browser-safe.
 */
export const LOCAL_SERVERS: ReadonlySet<string> = new Set(['junior', 'team', 'task', 'goal', 'gate', 'brief', 'browser'])

/** `mcp__<server>__<leaf>` → the server segment. */
export const serverOf = (toolName: string): string => {
  const rest = toolName.slice('mcp__'.length)
  const cut = rest.lastIndexOf('__')
  return cut === -1 ? rest : rest.slice(0, cut)
}

/** A call to one of Junior's own servers. */
export const isOwnTool = (toolName: string): boolean => toolName.startsWith('mcp__') && LOCAL_SERVERS.has(serverOf(toolName))

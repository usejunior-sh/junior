import { addFlags } from './args.js'
import { bold, cyan, die, dim, green } from './ui.js'
import { type WireWorkspace, serverPort } from './workspace.js'

/**
 * `junior add "…"`, a one-line hand-off without opening the app: a manual
 * item through the same route the inbox's own add uses (createManualOp).
 */
export async function addCmd(rest: string[]) {
  const title = rest.join(' ').trim()
  if (!title) die(`add needs a title, e.g. ${cyan('junior add "Look at the flaky deploy check"')}`)
  const port = await serverPort()
  if (!port) die(`add needs the server running — start it with ${cyan('junior')}`)
  // The HTTP API falls back to the default workspace for an id it doesn't
  // know, so a typo would file the item somewhere else, resolve it first.
  let ws = ''
  if (addFlags.workspace) {
    const ref = addFlags.workspace
    const { workspaces } = (await (await fetch(`http://localhost:${port}/api/workspaces`)).json()) as { workspaces: WireWorkspace[] }
    const match = workspaces.find((w) => w.id === ref || w.name.toLowerCase() === ref.toLowerCase())
    if (!match) die(`no workspace named "${ref}" — see ${cyan('junior workspace list')}`)
    ws = `?workspace=${encodeURIComponent(match.id)}`
  }
  const res = await fetch(`http://localhost:${port}/api/items/manual${ws}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title }),
  })
  const out = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as { ok: boolean; id?: string; error?: string }
  if (!out.ok) die(out.error ?? 'add failed')
  console.log(`${green('✓')} added ${bold(title)}${out.id ? ' ' + dim(`(${out.id})`) : ''}`)
}

import { checkHealth } from '../state.js'
import { explicitColor } from './args.js'
import { resolvePort } from './lifecycle.js'
import { bold, cyan, die, dim, green } from './ui.js'

// Prefer the running server's API (it owns the registry while it's up, edits
// behind its back would diverge from the runtimes it already built); fall back
// to the registry file only when no server is running.

export type WireWorkspace = { id: string; name: string; color: string; authBackend: string; isDefault: boolean }

export async function serverPort(): Promise<number | null> {
  const port = await resolvePort(false)
  const health = await checkHealth(port)
  return health && health !== 'other' ? port : null
}

function printWorkspaces(rows: WireWorkspace[]) {
  for (const w of rows) {
    const mark = w.isDefault ? green('*') : ' '
    console.log(`${mark} ${bold(w.name)} ${dim(`(${w.id} · ${w.authBackend})`)}`)
  }
}

export async function workspaceCmd(sub: string | undefined, name: string | undefined) {
  const { loadRegistry, saveRegistry, slugify, ensureWorkspaceDirs } = await import('../workspaces.js')
  const port = await serverPort()

  if (sub === 'list' || sub === undefined) {
    if (port) {
      const body = (await (await fetch(`http://localhost:${port}/api/workspaces`)).json()) as {
        ok: boolean
        workspaces?: WireWorkspace[]
        error?: string
      }
      if (!body.ok || !body.workspaces) die(body.error ?? 'could not list workspaces')
      printWorkspaces(body.workspaces)
    } else {
      const reg = loadRegistry()
      printWorkspaces(reg.workspaces.map((w) => ({ ...w, isDefault: w.id === reg.defaultId })))
    }
    return
  }

  if (sub === 'create') {
    if (!name) die(`workspace create needs a name, e.g. ${cyan('junior workspace create work')}`)
    if (port) {
      const body = (await (
        await fetch(`http://localhost:${port}/api/workspaces`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, ...(explicitColor ? { color: explicitColor } : {}) }),
        })
      ).json()) as { ok: boolean; workspace?: WireWorkspace; error?: string }
      if (!body.ok || !body.workspace) die(body.error ?? 'could not create the workspace')
      console.log(`${green('✓')} created workspace ${bold(body.workspace.name)} ${dim(`(${body.workspace.id})`)}`)
    } else {
      const reg = loadRegistry()
      let id = slugify(name)
      for (let n = 2; reg.workspaces.some((w) => w.id === id); n++) id = `${slugify(name)}-${n}`
      reg.workspaces.push({ id, name, color: explicitColor ?? '#7aa2f7', provider: 'claude', authBackend: 'inherit', createdAt: Date.now() })
      ensureWorkspaceDirs(id)
      saveRegistry(reg)
      console.log(`${green('✓')} created workspace ${bold(name)} ${dim(`(${id})`)} — picked up on the next server start`)
    }
    return
  }

  if (sub === 'use') {
    if (!name) die(`workspace use needs a name or id, e.g. ${cyan('junior workspace use work')}`)
    const reg = loadRegistry()
    const match = reg.workspaces.find((w) => w.id === name || w.name.toLowerCase() === name.toLowerCase())
    if (!match) die(`no workspace named "${name}" — see ${cyan('junior workspace list')}`)
    if (port) {
      const body = (await (
        await fetch(`http://localhost:${port}/api/workspaces/default`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: match.id }),
        })
      ).json()) as { ok: boolean; error?: string }
      if (!body.ok) die(body.error ?? 'could not switch the default workspace')
    } else {
      reg.defaultId = match.id
      saveRegistry(reg)
    }
    console.log(`${green('✓')} default workspace is now ${bold(match.name)} ${dim(`(${match.id})`)}`)
    return
  }

  die(`unknown workspace command "${sub}" — try ${cyan('junior workspace list')}`)
}

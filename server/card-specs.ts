/**
 * The workspace's card specs on disk: `<workspace>/cards/<id>.json`
 * (core/cards/spec.ts), ahead of the built-ins, so a file for a tool wins.
 *
 * Nothing is seeded: the built-ins live in code and a file only overrides. A
 * file that doesn't parse never crashes anything: it is left out, and its
 * error rides along for whoever lists the specs. Re-read when a file is
 * added, removed or changed (looked at no more than every couple of seconds),
 * so a spec Junior writes applies to the next card without a restart.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { BUILTIN_SPECS } from '../core/cards/builtin.js'
import { parseCardSpec, type CardSpec } from '../core/cards/spec.js'

export type CardSpecsState = {
  /** the workspace's specs first, then the built-ins: the order `specFor` reads */
  specs: readonly CardSpec[]
  /** one line per file that didn't load: "<id>: <what's wrong>" */
  errors: string[]
}

export class CardSpecs {
  readonly dir: string
  private cache: { signature: string; state: CardSpecsState } | null = null
  private checkedAt = 0

  constructor(root: string) {
    this.dir = path.join(root, 'cards')
  }

  /** The specs in force. Sync on purpose: views are built in a request, and the files are small. */
  current(): CardSpecsState {
    const now = Date.now()
    if (this.cache && now - this.checkedAt < 2_000) return this.cache.state
    this.checkedAt = now
    const files = this.files()
    const signature = files.map((f) => `${f.name}:${f.mtimeMs}`).join('|')
    if (this.cache && this.cache.signature === signature) return this.cache.state
    const mine: CardSpec[] = []
    const errors: string[] = []
    for (const f of files) {
      const id = f.name.slice(0, -'.json'.length)
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(path.join(this.dir, f.name), 'utf8')) as unknown
      } catch (err) {
        errors.push(`${id}: ${err instanceof SyntaxError ? `not valid JSON (${err.message})` : err instanceof Error ? err.message : String(err)}`)
        continue
      }
      const r = parseCardSpec(id, raw)
      if (r.ok) mine.push({ ...r.spec, source: 'workspace' })
      else errors.push(r.error)
    }
    const state: CardSpecsState = { specs: [...mine, ...BUILTIN_SPECS.map((s) => ({ ...s, source: 'builtin' as const }))], errors }
    this.cache = { signature, state }
    return state
  }

  /** `*.json` in the folder, sorted so the order (and the first match) never depends on the disk. */
  private files(): Array<{ name: string; mtimeMs: number }> {
    let names: string[]
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json') && !n.startsWith('.'))
    } catch {
      return []
    }
    const out: Array<{ name: string; mtimeMs: number }> = []
    for (const name of names.sort()) {
      try {
        out.push({ name, mtimeMs: statSync(path.join(this.dir, name)).mtimeMs })
      } catch {}
    }
    return out
  }
}

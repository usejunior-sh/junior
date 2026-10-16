/**
 * Artifacts (.docs/next-version.md, phase 1): markdown files with frontmatter
 * under one folder per workspace, indexed into SQLite so the UI, the `@`
 * picker and the MCP tools can list and link them without scanning disk.
 *
 *   ~/.triage/workspaces/<id>/artifacts/
 *     .git/          every server-side write is a commit — the history of a
 *                    brief's rewrites without a versions table
 *     notes/         human notes (and model notes written via the MCP tool)
 *     briefs/        phase 2: one brief per work item
 *     goals/         each goal's ledger (core/goals/ledger.ts) — not indexed here
 *
 * The file is the truth and this module never edits a file it did not write
 * except when asked to (PUT). Re-indexing is poll-on-demand: a listing older
 * than INDEX_TTL_MS walks the folder, and only files whose mtime or size moved
 * are re-parsed. A row whose file vanished is dropped, with its links.
 *
 * Nothing here reads outside `root`: paths are server-chosen, relative, `.md`,
 * free of `..`, and the realpath of every file touched must sit under the
 * realpath of the root — the same containment rule as files.ts.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isArtifactAuthor, type Artifact, type ArtifactAuthor } from '../shared/protocol.js'
import type { Store } from '../core/store/types.js'
import { canonicalizeRefs } from '../core/work/link.js'

const pExecFile = promisify(execFile)

/** How long an index is trusted before the next read walks the folder again. */
const INDEX_TTL_MS = 15_000

// ---------------------------------------------------------------------------
// Frontmatter — a deliberately small YAML subset, no dependency
//
//   ---
//   key: bare scalar
//   key: "quoted, with \" escapes"
//   key: [a, b, "c d"]
//   key:
//     - a
//     - b
//   ---
//   body…
//
// Unknown keys are kept and written back verbatim (as strings), so a file
// carrying its own metadata survives a round trip through PUT.
// ---------------------------------------------------------------------------

export type FrontmatterValue = string | string[]
export type Frontmatter = {
  data: Record<string, FrontmatterValue>
  body: string
  /** false when a `---` block was present but did not parse — defaults were used */
  ok: boolean
  /** true when the file had any frontmatter block at all */
  present: boolean
}

const KEY_RE = /^([A-Za-z_][\w-]*):(.*)$/

function unquote(v: string): string {
  return v.slice(1, -1).replace(/\\(["\\])/g, '$1')
}

function scalar(raw: string): string {
  const v = raw.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return unquote(v)
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1)
  return v
}

/** `[a, "b, c", d]` → items; quotes protect commas. */
function flowList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1)
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (quote) {
      if (c === '\\' && i + 1 < inner.length) {
        cur += c + inner[++i]
        continue
      }
      if (c === quote) quote = null
      cur += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
      continue
    }
    if (c === ',') {
      if (cur.trim()) out.push(scalar(cur))
      cur = ''
      continue
    }
    cur += c
  }
  if (cur.trim()) out.push(scalar(cur))
  return out
}

export function parseFrontmatter(text: string): Frontmatter {
  const nl = text.startsWith('---\r\n') ? '\r\n' : '\n'
  if (!text.startsWith('---' + nl)) return { data: {}, body: text, ok: true, present: false }
  const lines = text.split(/\r?\n/)
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return { data: {}, body: text, ok: false, present: true }
  const data: Record<string, FrontmatterValue> = {}
  let ok = true
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const m = KEY_RE.exec(line)
    if (!m) {
      ok = false
      continue
    }
    const key = m[1]
    const rest = m[2].trim()
    if (rest === '') {
      // block list, or an empty value
      const items: string[] = []
      while (i + 1 < end && /^\s+-\s/.test(lines[i + 1])) {
        items.push(scalar(lines[++i].replace(/^\s+-\s/, '')))
      }
      data[key] = items.length ? items : ''
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      data[key] = flowList(rest)
    } else {
      data[key] = scalar(rest)
    }
  }
  const body = lines.slice(end + 1).join('\n')
  return { data, body, ok, present: true }
}

const NEEDS_QUOTES = /^$|^[\s"'[\]{}#&*!|>%@`-]|[:#]|\s$/
const quote = (v: string) => (NEEDS_QUOTES.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v)

export function serializeFrontmatter(data: Record<string, FrontmatterValue>, body: string): string {
  const lines = ['---']
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.map(quote).join(', ')}]`)
    else lines.push(`${k}: ${quote(v)}`)
  }
  lines.push('---')
  return lines.join('\n') + '\n' + body.replace(/^\n+/, '')
}

// ---------------------------------------------------------------------------
// From a file to an index row
// ---------------------------------------------------------------------------

const asStrings = (v: FrontmatterValue | undefined): string[] =>
  Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []

const asTime = (v: FrontmatterValue | undefined, fallback: number): number => {
  if (typeof v !== 'string' || !v) return fallback
  if (/^\d+$/.test(v)) return Number(v)
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : fallback
}

const firstHeading = (body: string): string | null => {
  const m = /^#\s+(.+?)\s*$/m.exec(body)
  return m ? m[1] : null
}

/** "Update the CLI wizard" → "update-the-cli-wizard" (≤ 48 chars). */
export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'untitled'

export type ArtifactFile = { artifact: Artifact; body: string; data: Record<string, FrontmatterValue> }

function fromFile(rel: string, text: string, st: { mtimeMs: number; birthtimeMs: number; size: number }, knownId: string | null): ArtifactFile {
  const fm = parseFrontmatter(text)
  const d = fm.data
  const id = typeof d.id === 'string' && d.id ? d.id : knownId ?? randomUUID()
  const title =
    (typeof d.title === 'string' && d.title) || firstHeading(fm.body) || path.basename(rel, '.md')
  const author: ArtifactAuthor = isArtifactAuthor(d.author) ? d.author : 'human'
  const refs = canonicalizeRefs(asStrings(d.refs)) ?? []
  const created = asTime(d.created, st.birthtimeMs || st.mtimeMs)
  const updated = asTime(d.updated, st.mtimeMs)
  const artifact: Artifact = {
    id,
    path: rel,
    title,
    author,
    refs,
    created,
    updated,
    mtime: st.mtimeMs,
    size: st.size,
    ...(fm.present && !fm.ok ? { warning: 'frontmatter did not parse — title/author defaulted' } : {}),
  }
  return { artifact, body: fm.body, data: d }
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

export type WriteInput = {
  title: string
  body: string
  author: ArtifactAuthor
  refs?: string[]
}

export class ArtifactIndex {
  private lastRefresh = 0
  private inflight: Promise<boolean> | null = null
  private ensured: Promise<void> | null = null

  constructor(
    readonly root: string,
    private readonly store: Store,
    /** called after any change to the index — the server broadcasts it */
    private readonly onChange: () => void,
  ) {}

  /** The folder, its subfolders and its git repo exist. Idempotent, cheap after the first call. */
  ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = (async () => {
        await mkdir(path.join(this.root, 'notes'), { recursive: true })
        await mkdir(path.join(this.root, 'briefs'), { recursive: true })
        if (!existsSync(path.join(this.root, '.git'))) {
          try {
            await pExecFile('git', ['init', '-q'], { cwd: this.root })
          } catch {
            // no git — files still work, there is just no history
          }
        }
      })().catch(() => {
        this.ensured = null
      })
    }
    return this.ensured
  }

  // -- paths ----------------------------------------------------------------

  /** A relative path this index is allowed to touch, or throw. */
  private rel(p: string): string {
    const norm = p.split(path.sep).join('/').replace(/^\/+/, '')
    if (!norm.endsWith('.md')) throw new Error('artifacts are markdown files (.md)')
    if (norm.split('/').some((seg) => seg === '..' || seg === '' || seg === '.git')) throw new Error('invalid artifact path')
    return norm
  }

  /** Absolute path for a relative one, after the containment check on what exists of it. */
  private async abs(rel: string): Promise<string> {
    const target = path.join(this.root, ...this.rel(rel).split('/'))
    const realRoot = await realpath(this.root)
    // The file may not exist yet (a create) — check the deepest existing ancestor.
    let probe = target
    while (!existsSync(probe)) probe = path.dirname(probe)
    const real = await realpath(probe)
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('outside the artifacts folder')
    return target
  }

  // -- indexing -------------------------------------------------------------

  private async walk(): Promise<string[]> {
    const out: string[] = []
    const queue = ['']
    while (queue.length) {
      const rel = queue.shift()!
      let entries
      try {
        entries = await readdir(path.join(this.root, rel), { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (e.name === '.git' || e.name.startsWith('.')) continue
        // goals/<id>/ is each goal's ledger (core/goals/ledger.ts), shown on the goal page, not as artifacts
        if (!rel && e.name === 'goals') continue
        const p = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) queue.push(p)
        else if (e.isFile() && e.name.endsWith('.md')) out.push(p)
        // symlinks: neither followed nor listed
      }
    }
    return out
  }

  /** Re-read one file into the index (after a write). Returns the row. */
  private async indexFile(rel: string): Promise<ArtifactFile> {
    const abs = await this.abs(rel)
    const [text, st, known] = await Promise.all([readFile(abs, 'utf8'), stat(abs), this.store.artifacts.getByPath(rel)])
    const file = fromFile(rel, text, st, known?.id ?? null)
    await this.store.artifacts.upsert(file.artifact)
    return file
  }

  /** Walk the folder when the index is stale (or `force`). Resolves to whether anything changed. */
  refresh(force = false): Promise<boolean> {
    if (!force && Date.now() - this.lastRefresh < INDEX_TTL_MS) return Promise.resolve(false)
    if (!this.inflight) {
      this.inflight = this.doRefresh()
        .then((changed) => {
          this.lastRefresh = Date.now()
          if (changed) this.onChange()
          return changed
        })
        .finally(() => {
          this.inflight = null
        })
    }
    return this.inflight
  }

  private async doRefresh(): Promise<boolean> {
    await this.ensure()
    const files = new Set(await this.walk())
    const rows = await this.store.artifacts.list()
    const byPath = new Map(rows.map((r) => [r.path, r]))
    let changed = false
    for (const rel of files) {
      const row = byPath.get(rel)
      let st
      try {
        st = await stat(path.join(this.root, ...rel.split('/')))
      } catch {
        continue
      }
      if (row && row.mtime === st.mtimeMs && row.size === st.size) continue
      try {
        await this.indexFile(rel)
        changed = true
      } catch {
        // unreadable file — leave whatever row exists
      }
    }
    for (const row of rows) {
      if (files.has(row.path)) continue
      await this.store.artifacts.remove(row.id)
      await this.store.links.removeFor('artifact', row.id)
      changed = true
    }
    return changed
  }

  // -- reads ----------------------------------------------------------------

  /** The row plus the file's body and raw frontmatter, or null when unknown. */
  async read(id: string): Promise<(ArtifactFile & { abs: string }) | null> {
    await this.refresh()
    const row = await this.store.artifacts.get(id)
    if (!row) return null
    try {
      const abs = await this.abs(row.path)
      const text = await readFile(abs, 'utf8')
      const st = await stat(abs)
      const file = fromFile(row.path, text, st, row.id)
      return { ...file, artifact: { ...file.artifact, id: row.id }, abs }
    } catch {
      return null
    }
  }

  // -- writes ---------------------------------------------------------------

  private async writeText(rel: string, text: string): Promise<void> {
    const abs = await this.abs(rel)
    await mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.tmp`
    await writeFile(tmp, text, 'utf8')
    await rename(tmp, abs)
  }

  /** Stage everything and commit; a missing git or an empty tree is not an error. */
  async commit(message: string): Promise<void> {
    if (!existsSync(path.join(this.root, '.git'))) return
    const git = (args: string[]) =>
      pExecFile('git', ['-c', 'user.name=triage', '-c', 'user.email=triage@localhost', ...args], { cwd: this.root })
    try {
      await git(['add', '-A'])
      await git(['commit', '-q', '-m', message])
    } catch {
      // nothing to commit, or git unavailable — the file is written either way
    }
  }

  /** Create a new file under `subdir` (notes/ by default). Returns the indexed row. */
  async create(input: WriteInput, subdir = 'notes'): Promise<Artifact> {
    await this.ensure()
    const id = randomUUID()
    const rel = `${subdir}/${slug(input.title)}-${id.slice(0, 8)}.md`
    return this.writeNew(rel, id, input)
  }

  /**
   * Write a file at a known path (phase 2's briefs: one fixed path per item),
   * preserving `id` and `created` when a file is already there.
   */
  async writeAt(rel: string, input: WriteInput): Promise<Artifact> {
    await this.ensure()
    const existing = await this.store.artifacts.getByPath(this.rel(rel))
    if (!existing) return this.writeNew(rel, randomUUID(), input)
    return this.update(existing.id, input)
  }

  private async writeNew(rel: string, id: string, input: WriteInput): Promise<Artifact> {
    const now = new Date().toISOString()
    const data: Record<string, FrontmatterValue> = {
      id,
      title: input.title,
      author: input.author,
      ...(input.refs?.length ? { refs: canonicalizeRefs(input.refs) ?? [] } : {}),
      created: now,
      updated: now,
    }
    await this.writeText(rel, serializeFrontmatter(data, input.body))
    const file = await this.indexFile(this.rel(rel))
    // The id in the file is the truth; make sure the row carries it.
    if (file.artifact.id !== id) await this.store.artifacts.upsert({ ...file.artifact, id })
    await this.commit(`add ${rel}`)
    this.onChange()
    return { ...file.artifact, id }
  }

  /** Patch title/body/refs (and author, for a model rewrite) in place; `updated` moves to now. */
  async update(id: string, patch: Partial<WriteInput>): Promise<Artifact> {
    const cur = await this.read(id)
    if (!cur) throw new Error('artifact not found')
    const data: Record<string, FrontmatterValue> = { ...cur.data }
    data.id = id
    if (patch.title !== undefined) data.title = patch.title
    else if (typeof data.title !== 'string' || !data.title) data.title = cur.artifact.title
    if (patch.author !== undefined) data.author = patch.author
    else if (!isArtifactAuthor(data.author)) data.author = cur.artifact.author
    if (patch.refs !== undefined) {
      const refs = canonicalizeRefs(patch.refs) ?? []
      if (refs.length) data.refs = refs
      else delete data.refs
    }
    if (typeof data.created !== 'string' || !data.created) data.created = new Date(cur.artifact.created).toISOString()
    data.updated = new Date().toISOString()
    await this.writeText(cur.artifact.path, serializeFrontmatter(data, patch.body ?? cur.body))
    const file = await this.indexFile(cur.artifact.path)
    await this.commit(`update ${cur.artifact.path}`)
    this.onChange()
    return file.artifact
  }

  /** Delete the file (git keeps it), its row, and every link to it. */
  async remove(id: string): Promise<void> {
    const row = await this.store.artifacts.get(id)
    if (!row) return
    try {
      await rm(await this.abs(row.path), { force: true })
    } catch {
      // already gone
    }
    await this.store.artifacts.remove(id)
    await this.store.links.removeFor('artifact', id)
    await this.commit(`remove ${row.path}`)
    this.onChange()
  }
}

/**
 * Artifacts: files under one folder per workspace, indexed into SQLite so the
 * UI, the `@` picker and the MCP tools can list and link them without scanning
 * disk. Markdown carries its identity in frontmatter; every other format
 * (html, csv, txt, json, svg, pdf, images) is a pair, the file and a
 * `<file>.artifact.json` sidecar that holds id, title, author and refs.
 *
 *   ~/.triage/workspaces/<id>/artifacts/
 *     .git/          every server-side write is a commit. A version is one
 *                    commit that touched the artifact's file (`git log --follow`,
 *                    cut at a copy), numbered by its `Triage-Version` trailer
 *     notes/         human notes (and model notes written via the MCP tool)
 *     briefs/        one brief per work item
 *     files/         non-markdown artifacts: <slug>-<id8>.<ext> + sidecar
 *     goals/         each goal's ledger (core/goals/ledger.ts), not indexed here
 *
 * The file is the truth and this module never edits a file it did not write
 * except when asked to (PUT). Re-indexing is poll-on-demand: a listing older
 * than INDEX_TTL_MS walks the folder, and only files whose mtime or size moved
 * are re-parsed. A row whose file vanished is dropped, with its links; a file
 * that moved keeps its id (frontmatter or sidecar), so it keeps its row.
 *
 * Nothing here reads outside `root`: paths are server-chosen, relative, a
 * known extension, free of `..` and dot-segments, and the realpath of every
 * file touched must sit under the realpath of the root. The same containment
 * rule as files.ts. Paths read back from git go through the same check.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  ARTIFACT_BODY_MAX_CHARS,
  ARTIFACT_HISTORY_MAX_BYTES,
  ARTIFACT_MAX_BYTES,
  ARTIFACT_SIDECAR_SUFFIX,
  isArtifactAuthor,
  isArtifactFormat,
  isTextFormat,
  sniffFormat,
  type Artifact,
  type ArtifactAuthor,
  type ArtifactFormat,
  type ArtifactVersion,
} from '../shared/protocol.js'
import type { Store } from '../core/store/types.js'
import { canonicalizeRefs } from '../core/work/link.js'

const pExecFile = promisify(execFile)

/** How long an index is trusted before the next read walks the folder again. */
const INDEX_TTL_MS = 15_000

/** Versions listed at most; the numbering still counts every commit. */
const VERSIONS_LISTED = 200
const GIT_MAX_BUFFER = 64 * 1024 * 1024
const SHOW_MAX_BUFFER = 30 * 1024 * 1024
const GIT_IDENTITY = ['-c', 'user.name=triage', '-c', 'user.email=triage@localhost', '-c', 'commit.gpgsign=false']

// Frontmatter: a deliberately small YAML subset, no dependency
//
//   key: bare scalar
//   key: "quoted, with \" escapes"
//   key: [a, b, "c d"]
//   key:
//     - a
//     - b
//   body…
//
// Unknown keys are kept and written back verbatim (as strings), so a file
// carrying its own metadata survives a round trip through PUT.

export type FrontmatterValue = string | string[]
export type Frontmatter = {
  data: Record<string, FrontmatterValue>
  body: string
  /** false when a `---` block was present but did not parse, defaults were used */
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

// From a file to an index row

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

const SIDE = ARTIFACT_SIDECAR_SUFFIX
const extOf = (rel: string): string => path.extname(rel).slice(1).toLowerCase()
/** The format a content path says it is: only the extensions triage writes are in the table. */
const formatOfRel = (rel: string): ArtifactFormat | null => {
  const e = extOf(rel)
  return isArtifactFormat(e) ? e : null
}
const contentRelOf = (rel: string): string => (rel.endsWith(SIDE) ? rel.slice(0, -SIDE.length) : rel)

type Stat = { mtimeMs: number; birthtimeMs: number; size: number }
type Meta = { version: number; history: boolean }

function mdFromFile(rel: string, text: string, st: Stat, knownId: string | null, meta: Meta): ArtifactFile {
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
    format: 'md',
    version: meta.version,
    history: meta.history,
    ...(fm.present && !fm.ok ? { warning: 'frontmatter did not parse — title/author defaulted' } : {}),
  }
  return { artifact, body: fm.body, data: d }
}

/** What `<file>.artifact.json` holds: the identity a non-markdown file cannot carry itself. */
type Sidecar = {
  triage: 1
  id: string
  title: string
  author: ArtifactAuthor
  format: ArtifactFormat
  refs: string[]
  created: string
  updated: string
}

const serializeSidecar = (s: Sidecar): string => JSON.stringify(s, null, 2) + '\n'

function fileFromSidecar(rel: string, sideText: string | null, st: Stat, knownId: string | null, meta: Meta): ArtifactFile {
  let d: Record<string, unknown> = {}
  let warning: string | undefined
  try {
    const v: unknown = JSON.parse(sideText ?? '')
    if (v && typeof v === 'object' && !Array.isArray(v)) d = v as Record<string, unknown>
    else warning = 'sidecar is not an object — title/author defaulted'
  } catch {
    warning = 'sidecar did not parse — title/author defaulted'
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  const id = str(d.id) ?? knownId ?? randomUUID()
  const artifact: Artifact = {
    id,
    path: rel,
    title: str(d.title) ?? path.basename(rel, path.extname(rel)),
    author: isArtifactAuthor(d.author) ? d.author : 'human',
    refs: canonicalizeRefs(Array.isArray(d.refs) ? d.refs.filter((x): x is string => typeof x === 'string') : []) ?? [],
    created: asTime(str(d.created), st.birthtimeMs || st.mtimeMs),
    updated: asTime(str(d.updated), st.mtimeMs),
    mtime: st.mtimeMs,
    size: st.size,
    format: formatOfRel(rel) ?? 'txt',
    version: meta.version,
    history: meta.history,
    ...(warning ? { warning } : {}),
  }
  return { artifact, body: '', data: {} }
}

export type WriteInput = {
  title: string
  body: string
  author: ArtifactAuthor
  refs?: string[]
  /** create: the file's format (md by default); an update cannot change it */
  format?: ArtifactFormat
  /** the file's bytes, from a resolved `from:` source; wins over `body` */
  bytes?: Uint8Array
  /** one line about this version, kept in the commit */
  note?: string
  /** the session that wrote it, kept in the commit trailer */
  session?: string
}

type CommitOpts = { note?: string; session?: string; artifactId?: string; rel?: string; size?: number; version?: number }

type GitVersion = { version: number; sha: string; at: number; note?: string; sessionId?: string; path: string }

/** Rounded up, so a file just over the limit never reads as exactly the limit. */
const mb = (n: number) => `${Math.ceil(n / 104857.6) / 10} MB`

/** A commit note as one short plain line: control characters out, 500 characters at most. */
const cleanNote = (s: string | undefined): string | undefined => {
  const t = (s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500)
  return t || undefined
}

/**
 * The note, the Triage-Session trailer and the Triage-Version trailer of a
 * commit message. Trailers count only in the last paragraph, and a version
 * only next to the Triage-Artifact line the server writes with it, so a note
 * cannot pose as one.
 */
function parseCommitMessage(msg: string): { note?: string; sessionId?: string; version?: number } {
  const paras = msg.trim().split(/\n{2,}/).slice(1)
  let sessionId: string | undefined
  let version: number | undefined
  const last = paras[paras.length - 1]
  if (last && last.split('\n').every((l) => /^Triage-(Session|Artifact|Version): \S+$/.test(l))) {
    sessionId = /^Triage-Session: (\S+)$/m.exec(last)?.[1]
    const v = /^Triage-Version: ([1-9]\d{0,8})$/m.exec(last)?.[1]
    if (v && /^Triage-Artifact: /m.test(last)) version = Number(v)
    paras.pop()
  }
  const note = paras.join(' ').replace(/\s+/g, ' ').trim()
  return { ...(note ? { note } : {}), ...(sessionId ? { sessionId } : {}), ...(version ? { version } : {}) }
}

export class ArtifactIndex {
  private lastRefresh = 0
  private inflight: Promise<boolean> | null = null
  private ensured: Promise<void> | null = null
  /** writes run one at a time, file write to commit: a commit holds exactly the write that made it */
  private chain: Promise<unknown> = Promise.resolve()
  private backfilled = false

  constructor(
    readonly root: string,
    private readonly store: Store,
    /** called after any change to the index, the server broadcasts it */
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
            // no git: files still work, there is just no history
          }
        }
        // a write in flight must never be swept into a commit half done
        await this.setExcluded('*.tmp', true).catch(() => {})
      })().catch(() => {
        this.ensured = null
      })
    }
    return this.ensured
  }

  private hasGit(): boolean {
    return existsSync(path.join(this.root, '.git'))
  }

  /** A relative path this index is allowed to touch, or throw. */
  private rel(p: string): string {
    const norm = p.split(path.sep).join('/').replace(/^\/+/, '')
    if (norm.includes('\0')) throw new Error('invalid artifact path')
    const segs = norm.split('/')
    if (segs.some((seg) => seg === '' || seg === '.' || seg === '..' || seg === '.git')) throw new Error('invalid artifact path')
    // no hidden segments, except the sidecar suffix on the last one
    const content = contentRelOf(segs[segs.length - 1])
    if (!content || content.startsWith('.') || segs.slice(0, -1).some((seg) => seg.startsWith('.'))) throw new Error('invalid artifact path')
    if (!isArtifactFormat(extOf(content))) throw new Error('not an artifact file type')
    return norm
  }

  /** Absolute path for a relative one, after the containment check on what exists of it. */
  private async abs(rel: string): Promise<string> {
    const target = path.join(this.root, ...this.rel(rel).split('/'))
    const realRoot = await realpath(this.root)
    // The file may not exist yet (a create), check the deepest existing ancestor.
    let probe = target
    while (!existsSync(probe)) probe = path.dirname(probe)
    const real = await realpath(probe)
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('outside the artifacts folder')
    return target
  }

  // indexing

  /** Content files: every `.md`, and every non-markdown file that has its sidecar. */
  private async walk(): Promise<string[]> {
    const all = new Set<string>()
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
        else if (e.isFile()) all.add(p)
        // symlinks: neither followed nor listed
      }
    }
    const out: string[] = []
    for (const p of all) {
      if (p.endsWith('.md')) out.push(p)
      else if (p.endsWith(SIDE)) {
        // a sidecar names its file; one whose file is gone is an orphan and lists nothing
        const content = contentRelOf(p)
        if (!content.endsWith('.md') && formatOfRel(content) && all.has(content)) out.push(content)
      }
    }
    return out
  }

  /** Size of the content file, mtime of whichever of file and sidecar moved last. */
  private async statOf(rel: string): Promise<Stat> {
    const st = await stat(path.join(this.root, ...rel.split('/')))
    if (formatOfRel(rel) === 'md') return st
    const side = await stat(path.join(this.root, ...(rel + SIDE).split('/')))
    return { mtimeMs: Math.max(st.mtimeMs, side.mtimeMs), birthtimeMs: st.birthtimeMs, size: st.size }
  }

  /** Two files claim one id (a copy made in a file manager): the copy gets a fresh id, written into its own file. */
  private async stampId(rel: string, id: string): Promise<void> {
    if (formatOfRel(rel) === 'md') {
      const fm = parseFrontmatter(await readFile(await this.abs(rel), 'utf8'))
      await this.writeText(rel, serializeFrontmatter({ ...fm.data, id }, fm.body))
      return
    }
    const sideRel = rel + SIDE
    let d: Record<string, unknown> = {}
    try {
      const v: unknown = JSON.parse(await readFile(await this.abs(sideRel), 'utf8'))
      if (v && typeof v === 'object' && !Array.isArray(v)) d = v as Record<string, unknown>
    } catch {
      // a sidecar that did not parse is replaced
    }
    await this.writeText(sideRel, JSON.stringify({ ...d, triage: 1, id }, null, 2) + '\n')
  }

  /** Re-read one file into the index (after a write). Returns the row. */
  private async indexFile(rel: string, o: { claimed?: Map<string, string>; fresh?: boolean } = {}): Promise<ArtifactFile> {
    const abs = await this.abs(rel)
    const md = formatOfRel(rel) === 'md'
    const [st, known] = await Promise.all([this.statOf(rel), this.store.artifacts.getByPath(rel)])
    const text = md
      ? await readFile(abs, 'utf8')
      : await readFile(await this.abs(rel + SIDE), 'utf8').catch(() => null)
    const history = this.hasGit() && st.size <= ARTIFACT_HISTORY_MAX_BYTES
    let file = md
      ? mdFromFile(rel, text ?? '', st, known?.id ?? null, { version: 1, history })
      : fileFromSidecar(rel, text, st, known?.id ?? null, { version: 1, history })
    const id = file.artifact.id
    // The same id on another path is a move when that path's file is gone, a duplicate when it is not.
    const other = await this.store.artifacts.get(id)
    const claimedBy = o.claimed?.get(id)
    const duplicate =
      (other && other.path !== rel && existsSync(path.join(this.root, ...other.path.split('/')))) ||
      (claimedBy !== undefined && claimedBy !== rel)
    if (duplicate) {
      await this.stampId(rel, randomUUID())
      return this.indexFile(rel, o)
    }
    const before = known ?? other
    const version = before ? before.version : history && !o.fresh ? Math.max(1, (await this.gitVersions(rel)).at(-1)?.version ?? 1) : 1
    file = { ...file, artifact: { ...file.artifact, version } }
    await this.store.artifacts.upsert(file.artifact)
    o.claimed?.set(id, rel)
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

  /** Tell the clients the index changed, after a caller has finished adding its links. */
  touch(): void {
    this.onChange()
  }

  private async doRefresh(): Promise<boolean> {
    await this.ensure()
    const files = new Set(await this.walk())
    const rows = await this.store.artifacts.list()
    const byPath = new Map(rows.map((r) => [r.path, r]))
    const claimed = new Map<string, string>()
    for (const r of rows) if (files.has(r.path)) claimed.set(r.id, r.path)
    let changed = false
    for (const rel of files) {
      const row = byPath.get(rel)
      let st
      try {
        st = await this.statOf(rel)
      } catch {
        continue
      }
      if (row && row.mtime === st.mtimeMs && row.size === st.size) continue
      try {
        await this.indexFile(rel, { claimed })
        changed = true
      } catch {
        // unreadable file: leave whatever row exists
      }
    }
    for (const row of rows) {
      if (files.has(row.path)) continue
      // The file moved: indexFile re-homed this id at its new path, so the row is live.
      const cur = await this.store.artifacts.get(row.id)
      if (cur && cur.path !== row.path) continue
      await this.store.artifacts.remove(row.id)
      await this.store.links.removeFor('artifact', row.id)
      changed = true
    }
    if (!this.backfilled) {
      this.backfilled = true
      if (await this.backfillVersions().catch(() => false)) changed = true
    }
    return changed
  }

  // git

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** `/<rel>` in .git/info/exclude (or any other line): how a file over 10 MB stays out of history. */
  private async setExcluded(line: string, on: boolean): Promise<void> {
    const file = path.join(this.root, '.git', 'info', 'exclude')
    if (!existsSync(path.join(this.root, '.git'))) return
    await mkdir(path.dirname(file), { recursive: true })
    const text = await readFile(file, 'utf8').catch(() => '')
    const lines = text.split('\n')
    const has = lines.includes(line)
    if (on && !has) await writeFile(file, `${text && !text.endsWith('\n') ? text + '\n' : text}${line}\n`, 'utf8')
    else if (!on && has) await writeFile(file, lines.filter((l) => l !== line).join('\n'), 'utf8')
  }

  /**
   * Stage everything and commit; a missing git or an empty tree is not an
   * error. A file over 10 MB is kept out of the repo first (`rel` and `size`),
   * so it keeps no history. Resolves to the commit's sha, or null when nothing
   * was committed. Call it only inside `serial`: the writes hold the lock from
   * the file write to this commit, so no other write can land between them.
   */
  private async commitLocked(message: string, opts: CommitOpts = {}): Promise<string | null> {
    if (!this.hasGit()) return null
    const git = (args: string[]) => pExecFile('git', [...GIT_IDENTITY, ...args], { cwd: this.root, maxBuffer: GIT_MAX_BUFFER })
    let sha: string | null = null
    try {
      if (opts.rel) {
        const big = (opts.size ?? 0) > ARTIFACT_HISTORY_MAX_BYTES
        await this.setExcluded(`/${opts.rel}`, big)
        if (big) await git(['rm', '--cached', '-q', '--ignore-unmatch', '--', opts.rel]).catch(() => {})
      }
      await git(['add', '-A'])
      const args = ['commit', '-q', '-m', message]
      const note = cleanNote(opts.note)
      if (note) args.push('-m', note)
      const trailers = [
        opts.session && /^[\w.-]+$/.test(opts.session) ? `Triage-Session: ${opts.session}` : '',
        opts.artifactId && /^[\w.-]+$/.test(opts.artifactId) ? `Triage-Artifact: ${opts.artifactId}` : '',
        opts.artifactId && opts.version ? `Triage-Version: ${opts.version}` : '',
      ].filter(Boolean)
      if (trailers.length) args.push('-m', trailers.join('\n'))
      await git(args)
      sha = (await git(['rev-parse', 'HEAD'])).stdout.trim() || null
    } catch {
      // nothing to commit, or git unavailable, the file is written either way
    }
    return sha
  }

  /**
   * Commit whatever is waiting in the working tree (a move or an edit made
   * outside triage) as its own commit, before a write of ours. A move
   * committed alone is a pure rename, which git follows however much the
   * next version changes the file, and an edit made by hand is not folded
   * into Junior's version. Call it only inside `serial`, before the write.
   */
  private async syncLocked(): Promise<void> {
    if (!this.hasGit()) return
    try {
      const { stdout } = await pExecFile('git', ['status', '--porcelain'], { cwd: this.root, maxBuffer: GIT_MAX_BUFFER })
      if (stdout.trim()) await this.commitLocked('sync')
    } catch {
      // git unavailable: the write goes ahead without it
    }
  }

  /** Stage everything and commit, one at a time. Resolves to the commit's sha, or null when nothing was committed. */
  commit(message: string, opts: CommitOpts = {}): Promise<string | null> {
    return this.serial(() => this.commitLocked(message, opts))
  }

  /**
   * The commits that touched one file, oldest first, numbered. A commit that
   * carries a `Triage-Version` trailer keeps that number; one without (a
   * commit made outside triage, or before versions) is the one after the
   * commit before it. Renames are followed; a copy is not: `--follow` also
   * detects copies, and a new file whose bytes match another artifact's is
   * its own artifact, so the history stops at the commit that made the copy.
   */
  private async gitVersions(rel: string): Promise<GitVersion[]> {
    if (!this.hasGit()) return []
    let stdout: string
    try {
      ;({ stdout } = await pExecFile(
        'git',
        ['-c', 'core.quotepath=false', 'log', '--follow', '--name-status', '--format=%x1e%H%x1f%ct%x1f%B%x1f', '--', rel],
        { cwd: this.root, maxBuffer: GIT_MAX_BUFFER },
      ))
    } catch {
      return []
    }
    const newestFirst: (Omit<GitVersion, 'version'> & { tagged?: number })[] = []
    for (const rec of stdout.split('\x1e')) {
      if (!rec.trim()) continue
      const [sha = '', ct = '0', message = '', rest = ''] = rec.split('\x1f')
      if (!/^[0-9a-f]{40,64}$/.test(sha)) continue
      const line = rest.split('\n').map((l) => l.trimEnd()).find(Boolean)
      let p = rel
      let copied = false
      if (line) {
        const fields = line.split('\t')
        // the commit that removed the file (a file moved out of history) is not a version
        if (fields[0].startsWith('D')) continue
        copied = fields[0].startsWith('C')
        p = fields[fields.length - 1]
      }
      try {
        this.rel(p)
      } catch {
        continue
      }
      const { version: tagged, ...parsed } = parseCommitMessage(message)
      newestFirst.push({ sha, at: Number(ct) * 1000, path: p, ...parsed, ...(tagged ? { tagged } : {}) })
      if (copied) break
    }
    let prev = 0
    return newestFirst.reverse().map(({ tagged, ...v }) => {
      prev = Math.max(tagged ?? 0, prev + 1)
      return { ...v, version: prev }
    })
  }

  /** Raise the version of rows that predate versions, from one pass over the whole log. */
  private async backfillVersions(): Promise<boolean> {
    if (!this.hasGit()) return false
    const { stdout } = await pExecFile(
      'git',
      ['-c', 'core.quotepath=false', 'log', '--no-renames', '--name-status', '--format=%x00'],
      { cwd: this.root, maxBuffer: GIT_MAX_BUFFER },
    )
    const counts = new Map<string, number>()
    for (const chunk of stdout.split('\0')) {
      for (const line of chunk.split('\n')) {
        const [status, ...rest] = line.split('\t')
        if (!rest.length || status.startsWith('D')) continue
        const p = rest.join('\t')
        counts.set(p, (counts.get(p) ?? 0) + 1)
      }
    }
    let changed = false
    for (const row of await this.store.artifacts.list()) {
      const n = counts.get(row.path) ?? 0
      if (row.history && n > row.version) {
        await this.store.artifacts.upsert({ ...row, version: n })
        changed = true
      }
    }
    return changed
  }

  // reads

  /** The row plus the file's body and raw frontmatter, or null when unknown. */
  async read(id: string): Promise<(ArtifactFile & { abs: string }) | null> {
    await this.refresh()
    const row = await this.store.artifacts.get(id)
    if (!row) return null
    try {
      const abs = await this.abs(row.path)
      const meta = { version: row.version, history: row.history }
      let file: ArtifactFile
      if (row.format === 'md') {
        const [text, st] = await Promise.all([readFile(abs, 'utf8'), stat(abs)])
        file = mdFromFile(row.path, text, st, row.id, meta)
      } else {
        const side = await readFile(await this.abs(row.path + SIDE), 'utf8').catch(() => null)
        file = fileFromSidecar(row.path, side, await this.statOf(row.path), row.id, meta)
        // text formats come back as text, cut at the inline cap; binary ones are never loaded
        if (isTextFormat(row.format)) file.body = (await readFile(abs, 'utf8')).slice(0, ARTIFACT_BODY_MAX_CHARS)
      }
      return { ...file, artifact: { ...file.artifact, id: row.id }, abs }
    } catch {
      return null
    }
  }

  /**
   * The versions git holds for a row, oldest first, each with the number its
   * commit carries. The newest is the current version. A file that spent time
   * over 10 MB has numbers git never saw, so the row's own count can be higher
   * than the newest commit's: the numbers then stay ahead rather than going back.
   */
  private async numbered(row: Artifact): Promise<{ list: GitVersion[]; current: number }> {
    const list = await this.gitVersions(row.path)
    const newest = list.at(-1)?.version ?? 0
    // without history the current file is not in git: its version is after the last commit
    return { list, current: Math.max(row.version, row.history ? newest : newest + 1) }
  }

  /**
   * The file's bytes at version `v` (omitted = the current file). An older
   * version comes out of git by the path the file had at that commit.
   */
  async readBytes(
    id: string,
    v?: number,
  ): Promise<{ artifact: Artifact; bytes: Buffer; version: number; latest: boolean; abs: string; format: ArtifactFormat } | null> {
    await this.refresh()
    const row = await this.store.artifacts.get(id)
    if (!row) return null
    const abs = await this.abs(row.path)
    if (v !== undefined && (!Number.isInteger(v) || v < 1 || v > row.version)) throw new Error('no such version')
    if (v === undefined || v === row.version) {
      return { artifact: row, bytes: await readFile(abs), version: row.version, latest: true, abs, format: row.format }
    }
    const hit = (await this.numbered(row)).list.find((x) => x.version === v)
    if (!hit) throw new Error(row.history ? 'no such version' : 'no history kept for this file')
    await this.abs(hit.path)
    const { stdout } = await pExecFile('git', ['show', `${hit.sha}:${hit.path}`], {
      cwd: this.root,
      encoding: 'buffer',
      maxBuffer: SHOW_MAX_BUFFER,
    })
    return { artifact: row, bytes: stdout, version: v, latest: false, abs, format: row.format }
  }

  /** The file as text at version `v`. md loses its frontmatter. Binary formats come back empty. */
  async readText(
    id: string,
    v?: number,
  ): Promise<{ artifact: Artifact; text: string; truncated: boolean; binary: boolean; version: number; latest: boolean; abs: string } | null> {
    await this.refresh()
    const row = await this.store.artifacts.get(id)
    if (!row) return null
    if (!isTextFormat(row.format)) {
      const abs = await this.abs(row.path)
      const latest = v === undefined || v === row.version
      return { artifact: row, text: '', truncated: false, binary: true, version: v ?? row.version, latest, abs }
    }
    const r = await this.readBytes(id, v)
    if (!r) return null
    let text = r.bytes.toString('utf8')
    if (r.format === 'md') text = parseFrontmatter(text).body
    const truncated = text.length > ARTIFACT_BODY_MAX_CHARS
    return {
      artifact: r.artifact,
      text: truncated ? text.slice(0, ARTIFACT_BODY_MAX_CHARS) : text,
      truncated,
      binary: false,
      version: r.version,
      latest: r.latest,
      abs: r.abs,
    }
  }

  /** The version list, newest first. A file over 10 MB lists its current version plus whatever was committed before. */
  async versions(id: string): Promise<{ history: boolean; current: number; versions: ArtifactVersion[]; capped: boolean } | null> {
    await this.refresh()
    const row = await this.store.artifacts.get(id)
    if (!row) return null
    const { list, current } = await this.numbered(row)
    const synth = (version: number): ArtifactVersion => ({ version, sha: '', at: row.updated, path: row.path, current: true })
    let entries: ArtifactVersion[]
    if (row.history) {
      entries = list.length ? list.map((v) => ({ ...v, current: v.version === current })) : [synth(current)]
      if (current !== row.version) await this.store.artifacts.upsert({ ...row, version: current })
    } else {
      entries = [...list.map((v) => ({ ...v, current: false })), synth(current)]
    }
    entries.sort((a, b) => b.version - a.version)
    return { history: row.history, current, versions: entries.slice(0, VERSIONS_LISTED), capped: entries.length > VERSIONS_LISTED }
  }

  // writes

  private async writeText(rel: string, text: string): Promise<void> {
    await this.writeBytes(rel, Buffer.from(text, 'utf8'))
  }

  private async writeBytes(rel: string, bytes: Uint8Array): Promise<void> {
    const abs = await this.abs(rel)
    await mkdir(path.dirname(abs), { recursive: true })
    const tmp = `${abs}.${process.pid}.tmp`
    await writeFile(tmp, bytes)
    await rename(tmp, abs)
  }

  /** The size cap, the format check and, for json, validity. Throws a message fit to show the model. */
  private check(format: ArtifactFormat, bytes: Uint8Array): void {
    if (bytes.byteLength > ARTIFACT_MAX_BYTES) throw new Error(`${mb(bytes.byteLength)} is over the 25 MB limit for an artifact`)
    const why = sniffFormat(format, bytes)
    if (why) throw new Error(why)
    if (format === 'json') {
      try {
        JSON.parse(Buffer.from(bytes).toString('utf8'))
      } catch {
        throw new Error('body is not valid JSON')
      }
    }
  }

  private checkSize(bytes: number): void {
    if (bytes > ARTIFACT_MAX_BYTES) throw new Error(`${mb(bytes)} is over the 25 MB limit for an artifact`)
  }

  /**
   * Commit a write and fix the row's version. A write that makes a version
   * (`created` or `bump`) is numbered here, before the commit, and the number
   * goes into the commit as a `Triage-Version` trailer: the number stays with
   * its commit even when a file spent time over 10 MB with no history. git can
   * know more than the row (a backfill, a commit made elsewhere), so the next
   * number is after the newest one git holds.
   */
  private async settle(
    art: Artifact,
    rel: string,
    o: { message: string; note?: string; session?: string; bump: boolean; created?: boolean },
  ): Promise<Artifact> {
    const fallback = o.bump ? art.version + 1 : art.version
    const makes = o.bump || o.created === true
    let version = fallback
    if (makes && art.history) version = Math.max(fallback, ((await this.gitVersions(rel)).at(-1)?.version ?? 0) + 1)
    await this.commitLocked(o.message, {
      ...(o.note ? { note: o.note } : {}),
      ...(o.session ? { session: o.session } : {}),
      artifactId: art.id,
      rel,
      size: art.size,
      ...(makes ? { version } : {}),
    })
    const final = version === art.version ? art : { ...art, version }
    if (final !== art) await this.store.artifacts.upsert(final)
    this.onChange()
    return final
  }

  /** Create a new file under `subdir` (notes/ for md, files/ for the rest). Returns the indexed row. */
  async create(input: WriteInput, subdir?: string): Promise<Artifact> {
    await this.ensure()
    return this.serial(() => this.createLocked(input, subdir))
  }

  private async createLocked(input: WriteInput, subdir?: string): Promise<Artifact> {
    await this.syncLocked()
    const id = randomUUID()
    const format = input.format ?? 'md'
    const name = `${slug(input.title)}-${id.slice(0, 8)}`
    if (format === 'md') return this.writeNewLocked(`${subdir ?? 'notes'}/${name}.md`, id, input)
    const bytes = input.bytes ?? Buffer.from(input.body, 'utf8')
    this.check(format, bytes)
    const rel = this.rel(`${subdir ?? 'files'}/${name}.${format}`)
    const now = new Date().toISOString()
    const side: Sidecar = {
      triage: 1,
      id,
      title: input.title,
      author: input.author,
      format,
      refs: input.refs?.length ? canonicalizeRefs(input.refs) ?? [] : [],
      created: now,
      updated: now,
    }
    await this.writeBytes(rel, bytes)
    await this.writeText(rel + SIDE, serializeSidecar(side))
    const file = await this.indexFile(rel, { fresh: true })
    return this.settle({ ...file.artifact, id }, rel, {
      message: `add ${rel}`,
      ...(input.note ? { note: input.note } : {}),
      ...(input.session ? { session: input.session } : {}),
      bump: false,
      created: true,
    })
  }

  /**
   * Write a file at a known path (a brief: one fixed path per item),
   * preserving `id` and `created` when a file is already there.
   */
  async writeAt(rel: string, input: WriteInput): Promise<Artifact> {
    await this.ensure()
    const existing = await this.store.artifacts.getByPath(this.rel(rel))
    if (!existing) {
      return this.serial(async () => {
        await this.syncLocked()
        return this.writeNewLocked(rel, randomUUID(), input)
      })
    }
    return this.update(existing.id, input)
  }

  private async writeNewLocked(rel: string, id: string, input: WriteInput): Promise<Artifact> {
    let body = input.body
    if (input.bytes) {
      this.check('md', input.bytes)
      body = Buffer.from(input.bytes).toString('utf8')
    }
    const now = new Date().toISOString()
    const data: Record<string, FrontmatterValue> = {
      id,
      title: input.title,
      author: input.author,
      ...(input.refs?.length ? { refs: canonicalizeRefs(input.refs) ?? [] } : {}),
      created: now,
      updated: now,
    }
    const text = serializeFrontmatter(data, body)
    this.checkSize(Buffer.byteLength(text))
    await this.writeText(rel, text)
    const file = await this.indexFile(this.rel(rel), { fresh: true })
    // The id in the file is the truth; make sure the row carries it.
    if (file.artifact.id !== id) await this.store.artifacts.upsert({ ...file.artifact, id })
    return this.settle({ ...file.artifact, id }, this.rel(rel), {
      message: `add ${rel}`,
      ...(input.note ? { note: input.note } : {}),
      ...(input.session ? { session: input.session } : {}),
      bump: false,
      created: true,
    })
  }

  /** Patch title/body/refs (and author, for a model rewrite) in place; `updated` moves to now. */
  async update(id: string, patch: Partial<WriteInput>): Promise<Artifact> {
    return (await this.revise(id, patch)).artifact
  }

  /**
   * `update`, saying whether anything was written. A non-markdown patch that
   * changes nothing writes no file and makes no commit. The format is fixed
   * for the artifact's life.
   */
  revise(id: string, patch: Partial<WriteInput>): Promise<{ artifact: Artifact; changed: boolean }> {
    return this.serial(() => this.reviseLocked(id, patch))
  }

  private async reviseLocked(id: string, patch: Partial<WriteInput>): Promise<{ artifact: Artifact; changed: boolean }> {
    await this.syncLocked()
    const cur = await this.read(id)
    if (!cur) throw new Error('artifact not found')
    if (patch.format !== undefined && patch.format !== cur.artifact.format) {
      throw new Error('the format cannot change; publish a new artifact for that')
    }
    return cur.artifact.format === 'md' ? this.reviseMd(cur, patch) : this.reviseFile(cur, patch)
  }

  private async reviseMd(cur: ArtifactFile & { abs: string }, patch: Partial<WriteInput>): Promise<{ artifact: Artifact; changed: boolean }> {
    let body = patch.body
    if (patch.bytes) {
      this.check('md', patch.bytes)
      body = Buffer.from(patch.bytes).toString('utf8')
    }
    const data: Record<string, FrontmatterValue> = { ...cur.data }
    data.id = cur.artifact.id
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
    const text = serializeFrontmatter(data, body ?? cur.body)
    this.checkSize(Buffer.byteLength(text))
    const rel = cur.artifact.path
    await this.writeText(rel, text)
    const file = await this.indexFile(rel)
    const artifact = await this.settle(file.artifact, rel, {
      message: `update ${rel}`,
      ...(patch.note ? { note: patch.note } : {}),
      ...(patch.session ? { session: patch.session } : {}),
      bump: true,
    })
    return { artifact, changed: true }
  }

  private async reviseFile(cur: ArtifactFile & { abs: string }, patch: Partial<WriteInput>): Promise<{ artifact: Artifact; changed: boolean }> {
    const art = cur.artifact
    const rel = art.path
    const bytes = patch.bytes ?? (patch.body !== undefined ? Buffer.from(patch.body, 'utf8') : undefined)
    let contentChanged = false
    if (bytes) {
      this.check(art.format, bytes)
      contentChanged = !(await readFile(cur.abs)).equals(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
    }
    const refs = patch.refs !== undefined ? canonicalizeRefs(patch.refs) ?? [] : art.refs
    const metaChanged =
      (patch.title !== undefined && patch.title !== art.title) ||
      (patch.author !== undefined && patch.author !== art.author) ||
      JSON.stringify(refs) !== JSON.stringify(art.refs)
    if (!contentChanged && !metaChanged) return { artifact: art, changed: false }
    const side: Sidecar = {
      triage: 1,
      id: art.id,
      title: patch.title ?? art.title,
      author: patch.author ?? art.author,
      format: art.format,
      refs,
      created: new Date(art.created).toISOString(),
      updated: new Date().toISOString(),
    }
    if (contentChanged && bytes) await this.writeBytes(rel, bytes)
    await this.writeText(rel + SIDE, serializeSidecar(side))
    const file = await this.indexFile(rel)
    const artifact = await this.settle(file.artifact, rel, {
      message: `update ${rel}`,
      ...(patch.note ? { note: patch.note } : {}),
      ...(patch.session ? { session: patch.session } : {}),
      bump: contentChanged,
    })
    return { artifact, changed: true }
  }

  /** Delete the file and its sidecar (git keeps them), its row, and every link to it. */
  remove(id: string): Promise<void> {
    return this.serial(() => this.removeLocked(id))
  }

  private async removeLocked(id: string): Promise<void> {
    await this.syncLocked()
    const row = await this.store.artifacts.get(id)
    if (!row) return
    const rels = row.format === 'md' ? [row.path] : [row.path, row.path + SIDE]
    for (const rel of rels) {
      try {
        await rm(await this.abs(rel), { force: true })
      } catch {
        // already gone
      }
    }
    await this.setExcluded(`/${row.path}`, false).catch(() => {})
    await this.store.artifacts.remove(id)
    await this.store.links.removeFor('artifact', id)
    await this.commitLocked(`remove ${row.path}`)
    this.onChange()
  }
}

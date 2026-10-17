/**
 * Skills and agents, every one a Claude Code session can see, as the files
 * Claude Code itself reads:
 *
 *   workspace  <workspace>/library/{skills/<name>/SKILL.md, agents/<name>.md}
 *              a local plugin named "triage", loaded into this workspace's chat
 *              sessions, so its skills are `/triage:<name>`, its agents
 *              `triage:<name>`
 *   personal   <claude config dir>/{skills,agents}    (~/.claude unless the
 *              workspace's auth points elsewhere)
 *   project    <project>/.claude/{skills,agents}, for each registered project
 *   plugin     installed plugins' skills/ and agents/, listed and readable,
 *              never written: the plugin manager replaces those folders
 *
 * Team agents (<workspace>/agents) are a different thing, a team run's cast,
 * not a chat's subagents, and stay with server/teams.ts.
 *
 * Every path the API takes is checked against these roots, so the editor can
 * only ever touch a skill or agent file.
 */
import { existsSync } from 'node:fs'
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LibraryEntry, LibraryKind, LibrarySource, LibraryTarget } from '../shared/protocol.js'
import { readFields, slugName } from '../shared/skillFile.js'

/** The plugin name the workspace library loads under, the `triage:` in `/triage:<skill>`. */
export const WORKSPACE_PLUGIN = 'triage'

/** A folder holding skills/ and agents/: editable unless it's a plugin's. */
export type LibraryRoot = {
  id: string
  source: LibrarySource
  label: string
  dir: string
  editable: boolean
  /** plugin roots: the namespace their skills and agents are called by */
  namespace?: string
}

const MAX_FILE = 512 * 1024
const MAX_SKILL_FILES = 300

/** Make the workspace library a loadable plugin: a manifest and the two folders. */
export async function ensureWorkspacePlugin(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'skills'), { recursive: true })
  await mkdir(path.join(dir, 'agents'), { recursive: true })
  const manifest = path.join(dir, '.claude-plugin', 'plugin.json')
  if (!existsSync(manifest)) {
    await mkdir(path.dirname(manifest), { recursive: true })
    await writeFile(
      manifest,
      JSON.stringify({ name: WORKSPACE_PLUGIN, description: "This triage workspace's own skills and agents." }, null, 2) + '\n',
    )
  }
}

/** The Claude config dir a spawn with `env` reads: CLAUDE_CONFIG_DIR, else ~/.claude. */
export const claudeHome = (env: Record<string, string> | undefined): string =>
  env?.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const v = JSON.parse(await readFile(file, 'utf8')) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Installed plugins a session here would load: user-scope ones that are
 * enabled, and project/local-scope ones installed for a registered project.
 */
async function pluginRoots(home: string, projects: string[]): Promise<LibraryRoot[]> {
  const installed = await readJson(path.join(home, 'plugins', 'installed_plugins.json'))
  const settings = await readJson(path.join(home, 'settings.json'))
  const enabled = (settings?.enabledPlugins ?? {}) as Record<string, unknown>
  const plugins = (installed?.plugins ?? {}) as Record<string, Array<{ scope?: string; projectPath?: string; installPath?: string }>>
  const roots: LibraryRoot[] = []
  const seen = new Set<string>()
  for (const [key, installs] of Object.entries(plugins)) {
    if (!Array.isArray(installs)) continue
    const name = key.split('@')[0]
    for (const inst of installs) {
      if (!inst.installPath || seen.has(inst.installPath)) continue
      const forUser = inst.scope === 'user' && enabled[key] === true
      const forProject = inst.scope !== 'user' && !!inst.projectPath && projects.includes(inst.projectPath)
      if (!forUser && !forProject) continue
      seen.add(inst.installPath)
      roots.push({ id: `plugin:${key}:${inst.installPath}`, source: 'plugin', label: name, dir: inst.installPath, editable: false, namespace: name })
    }
  }
  return roots
}

/** Every root, in the order the tabs list them. */
export async function libraryRoots(opts: {
  /** <workspace>/library */
  workspaceLibrary: string
  env: Record<string, string> | undefined
  projects: Array<{ name: string; path: string }>
}): Promise<LibraryRoot[]> {
  const home = claudeHome(opts.env)
  return [
    { id: 'workspace', source: 'workspace', label: 'Workspace', dir: opts.workspaceLibrary, editable: true, namespace: WORKSPACE_PLUGIN },
    { id: 'personal', source: 'personal', label: 'Personal', dir: home, editable: true },
    ...opts.projects.map((p): LibraryRoot => ({ id: `project:${p.path}`, source: 'project', label: p.name, dir: path.join(p.path, '.claude'), editable: true })),
    ...(await pluginRoots(home, opts.projects.map((p) => p.path))),
  ]
}

/** Where a new skill or agent can go. */
export const libraryTargets = (roots: LibraryRoot[]): LibraryTarget[] =>
  roots.filter((r) => r.editable).map((r) => ({ id: r.id, label: r.label, dir: r.dir }))

const isDirent = async (p: string): Promise<'dir' | 'file' | null> => {
  try {
    const s = await stat(p) // follows symlinks: linked skill folders are common
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null
  } catch {
    return null
  }
}

async function entriesIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((n) => !n.startsWith('.')).sort()
  } catch {
    return []
  }
}

/** A skill folder's files, relative to it, SKILL.md first. Skips dotfiles and dependency folders. */
export async function skillFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  async function walk(rel: string, depth: number) {
    if (out.length >= MAX_SKILL_FILES || depth > 4) return
    for (const n of await entriesIn(path.join(dir, rel))) {
      if (n === 'node_modules' || n === '__pycache__') continue
      const r = rel ? `${rel}/${n}` : n
      const kind = await isDirent(path.join(dir, r))
      if (kind === 'dir') await walk(r, depth + 1)
      else if (kind === 'file') out.push(r)
      if (out.length >= MAX_SKILL_FILES) return
    }
  }
  await walk('', 0)
  return out.sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)))
}

async function readHead(file: string): Promise<string> {
  try {
    const text = await readFile(file, 'utf8')
    return text.length > 64 * 1024 ? text.slice(0, 64 * 1024) : text
  } catch {
    return ''
  }
}

const called = (root: LibraryRoot, name: string) => (root.namespace ? `${root.namespace}:${name}` : name)

async function skillsIn(root: LibraryRoot): Promise<LibraryEntry[]> {
  const base = path.join(root.dir, 'skills')
  const out: LibraryEntry[] = []
  for (const slug of await entriesIn(base)) {
    const file = path.join(base, slug, 'SKILL.md')
    if ((await isDirent(file)) !== 'file') continue
    const f = readFields(await readHead(file))
    out.push({
      kind: 'skill',
      name: called(root, f.name || slug),
      slug,
      description: f.description ?? '',
      source: root.source,
      scope: root.label,
      path: file,
      editable: root.editable,
      files: Math.max(0, (await skillFiles(path.join(base, slug))).length - 1),
    })
  }
  return out
}

async function agentsIn(root: LibraryRoot): Promise<LibraryEntry[]> {
  const base = path.join(root.dir, 'agents')
  const out: LibraryEntry[] = []
  for (const n of await entriesIn(base)) {
    if (!n.endsWith('.md')) continue
    const file = path.join(base, n)
    if ((await isDirent(file)) !== 'file') continue
    const f = readFields(await readHead(file))
    const slug = n.slice(0, -3)
    out.push({
      kind: 'agent',
      name: called(root, f.name || slug),
      slug,
      description: f.description ?? '',
      source: root.source,
      scope: root.label,
      path: file,
      editable: root.editable,
      ...(f.model ? { model: f.model } : {}),
      ...(f.color ? { color: f.color } : {}),
      ...(f.tools ? { tools: f.tools } : {}),
    })
  }
  return out
}

export async function listLibrary(kind: LibraryKind, roots: LibraryRoot[]): Promise<LibraryEntry[]> {
  const lists = await Promise.all(roots.map((r) => (kind === 'skill' ? skillsIn(r) : agentsIn(r))))
  return lists.flat()
}

// Files: every path is resolved against the roots before anything is read or written

export type Located = {
  root: LibraryRoot
  kind: LibraryKind
  /** the skill's folder, or the agent's file */
  item: string
  /** the file asked for */
  file: string
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + path.sep)

/**
 * Which root, kind and skill/agent a path belongs to, or an error. A skill's
 * path may be any file in its folder; an agent's must be its .md.
 */
export function locate(p: unknown, roots: LibraryRoot[]): Located {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('need an absolute path')
  const file = path.normalize(p)
  for (const root of roots) {
    const skills = path.join(root.dir, 'skills')
    const agents = path.join(root.dir, 'agents')
    if (inside(file, skills) && file !== skills) {
      const slug = path.relative(skills, file).split(path.sep)[0]
      if (!slug || slug.startsWith('.') || file === path.join(skills, slug)) break
      return { root, kind: 'skill', item: path.join(skills, slug), file }
    }
    if (path.dirname(file) === agents && file.endsWith('.md')) return { root, kind: 'agent', item: file, file }
  }
  throw new Error('not a skill or agent file triage knows about')
}

/**
 * Refuse a path that escapes through a symlink planted inside the folder. A
 * skill folder may itself be a link (people keep skills in a repo and link
 * them in), what counts is staying inside wherever that folder really is.
 */
async function realInside(loc: Located): Promise<void> {
  let probe = loc.file
  while (!existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe)
  const real = await realpath(probe)
  const anchor = await realpath(loc.kind === 'skill' ? loc.item : path.dirname(loc.item)).catch(() => null)
  if (!anchor || !inside(real, anchor)) throw new Error('that path leaves its folder')
}

export async function readLibraryFile(p: unknown, roots: LibraryRoot[]) {
  const loc = locate(p, roots)
  await realInside(loc)
  const s = await stat(loc.file)
  if (!s.isFile()) throw new Error('not a file')
  const buf = s.size > MAX_FILE ? null : await readFile(loc.file)
  const binary = !buf || buf.subarray(0, 8000).includes(0)
  return {
    path: loc.file,
    text: binary ? '' : buf!.toString('utf8'),
    editable: loc.root.editable && !binary,
    binary,
    files: loc.kind === 'skill' ? await skillFiles(loc.item) : [path.basename(loc.file)],
    dir: loc.kind === 'skill' ? loc.item : path.dirname(loc.file),
  }
}

export async function writeLibraryFile(p: unknown, text: unknown, roots: LibraryRoot[]): Promise<Located> {
  if (typeof text !== 'string') throw new Error('need the file text')
  if (text.length > MAX_FILE) throw new Error('that file is too big to save from here')
  const loc = locate(p, roots)
  if (!loc.root.editable) throw new Error(`${loc.root.label} is a plugin — its files are replaced on update, so they're read-only here`)
  await realInside(loc)
  await mkdir(path.dirname(loc.file), { recursive: true })
  await writeFile(loc.file, text)
  return loc
}

const SKILL_TEMPLATE = (name: string, description: string) => `---
name: ${name}
description: ${description || `What ${name} does, and when Claude should use it.`}
---

# ${name}

Steps Claude follows when this skill is used.
`

const AGENT_TEMPLATE = (name: string, description: string) => `---
name: ${name}
description: ${description || `When Claude should hand work to ${name}.`}
---

You are ${name}. Describe the job, how to do it, and what to hand back.
`

/** Make a new skill or agent from a short template; refuses a name already taken. */
export async function createLibraryEntry(
  body: unknown,
  roots: LibraryRoot[],
): Promise<{ path: string; kind: LibraryKind; root: LibraryRoot }> {
  const b = (body ?? {}) as { kind?: unknown; target?: unknown; name?: unknown; description?: unknown }
  if (b.kind !== 'skill' && b.kind !== 'agent') throw new Error('need kind: skill or agent')
  const root = roots.find((r) => r.id === b.target && r.editable)
  if (!root) throw new Error('pick where it goes: the workspace, personal, or a project')
  const name = slugName(typeof b.name === 'string' ? b.name : '')
  if (!name) throw new Error('give it a name')
  const description = typeof b.description === 'string' ? b.description.replace(/\s+/g, ' ').trim() : ''
  if (root.source === 'workspace') await ensureWorkspacePlugin(root.dir)
  const file = b.kind === 'skill' ? path.join(root.dir, 'skills', name, 'SKILL.md') : path.join(root.dir, 'agents', `${name}.md`)
  if (existsSync(b.kind === 'skill' ? path.dirname(file) : file)) throw new Error(`${root.label} already has a ${b.kind} called "${name}"`)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, b.kind === 'skill' ? SKILL_TEMPLATE(name, description) : AGENT_TEMPLATE(name, description))
  return { path: file, kind: b.kind, root }
}

/**
 * Delete a skill (its whole folder) or an agent, or one supporting file of a
 * skill. Never a hard delete: it moves to <trashDir>, so a slip is recoverable.
 */
export async function removeLibraryItem(p: unknown, roots: LibraryRoot[], trashDir: string, opts: { fileOnly?: boolean } = {}): Promise<Located> {
  const loc = locate(p, roots)
  if (!loc.root.editable) throw new Error(`${loc.root.label} is a plugin — remove it with /plugin instead`)
  await realInside(loc)
  const target = opts.fileOnly ? loc.file : loc.item
  if (opts.fileOnly && path.basename(target) === 'SKILL.md' && path.dirname(target) === loc.item) throw new Error('SKILL.md is the skill — delete the skill instead')
  const dest = path.join(trashDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${loc.kind}-${path.basename(target)}`)
  await mkdir(trashDir, { recursive: true })
  // A linked skill folder: drop the link, never what it points at.
  if ((await lstat(target)).isSymbolicLink()) {
    await rm(target)
    return loc
  }
  try {
    await rename(target, dest)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(target, dest, { recursive: true })
    await rm(target, { recursive: true, force: true })
  }
  return loc
}

/** A path a session's tool touched that is a skill or agent file, the cue to hot-reload. */
export const touchesLibrary = (file: string, roots: LibraryRoot[]): boolean => {
  try {
    locate(file, roots.filter((r) => r.editable))
    return true
  } catch {
    return false
  }
}

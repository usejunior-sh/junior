/**
 * Project suggestions: the git repos where Claude Code already runs most,
 * read from Claude's own projects folder (`<CLAUDE_CONFIG_DIR>/projects`).
 * Read-only: nothing here writes, spawns `git` or calls a model. The ranking
 * is pure, in core/junior/project-rank.ts.
 *
 * Every path is an argument, so tests point it at a fixture directory and
 * never at the real home folder; only `projectSuggestionsOp` resolves the
 * workspace's real Claude folder, at runtime.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  decodeProjectKey,
  originUrlFromGitConfig,
  projectKey,
  rankProjects,
  repoFromRemoteUrl,
  type ProjectSighting,
  type ProjectSuggestion,
} from '../core/junior/project-rank.js'
import type { WorkspaceRuntime } from './workspace/runtime.js'
import { claudeHome } from './library.js'

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** How much of a session file to read looking for its `cwd`. */
const HEAD_BYTES = 64 * 1024

/** The first `cwd` a session file records, from its first 64 KB, or null. */
async function cwdOfSession(file: string): Promise<string | null> {
  let fh
  try {
    fh = await open(file, 'r')
    const buf = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0)
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n')
    // the last line may be cut mid-way; JSON.parse just skips it
    for (const line of lines) {
      if (!line.includes('"cwd"')) continue
      try {
        const v = JSON.parse(line) as { cwd?: unknown }
        if (typeof v.cwd === 'string' && path.isAbsolute(v.cwd)) return v.cwd
      } catch {
        /* a cut or odd line: keep looking */
      }
    }
    return null
  } catch {
    return null
  } finally {
    await fh?.close()
  }
}

export type RepoInfo = { root: string; repo?: string }

/**
 * The git repo a folder sits in: walk up to the nearest `.git`. A worktree's
 * `.git` file points into `<main>/.git/worktrees/<name>`, so it resolves to
 * the main repo. Returns null when no repo holds the folder.
 */
export function repoOf(folder: string): RepoInfo | null {
  let dir = path.resolve(folder)
  for (;;) {
    const dotGit = path.join(dir, '.git')
    if (existsSync(dotGit)) {
      let root = dir
      let gitDir = dotGit
      if (!isDir(dotGit)) {
        // a worktree or submodule: `gitdir: <path>`
        try {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
          if (!m) return null
          const target = path.resolve(dir, m[1]!.trim())
          const wt = /^(.*)[/\\]\.git[/\\]worktrees[/\\][^/\\]+$/.exec(target)
          if (wt) {
            root = wt[1]!
            gitDir = path.join(root, '.git')
          } else gitDir = target
        } catch {
          return null
        }
      }
      let repo: string | undefined
      try {
        const url = originUrlFromGitConfig(readFileSync(path.join(gitDir, 'config'), 'utf8'))
        repo = (url && repoFromRemoteUrl(url)) || undefined
      } catch {
        /* no config: still a repo, just not tied to GitHub */
      }
      return { root, repo }
    }
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/**
 * Every folder Claude Code ran in that still exists and sits in a git repo,
 * from `projectsDir` (one subfolder per launch directory, one `.jsonl` per
 * session). The launch directory comes from a session's own `cwd` when it
 * matches the folder's name, else from decoding the name against the disk.
 */
export async function scanClaudeProjects(projectsDir: string): Promise<ProjectSighting[]> {
  let entries
  try {
    entries = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return [] // no Claude Code here yet
  }
  const out: ProjectSighting[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(projectsDir, entry.name)
    let files: string[]
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    if (!files.length) continue
    const sessions: { file: string; at: number }[] = []
    for (const f of files) {
      try {
        sessions.push({ file: path.join(dir, f), at: (await stat(path.join(dir, f))).mtimeMs })
      } catch {
        /* removed mid-scan */
      }
    }
    if (!sessions.length) continue
    sessions.sort((a, b) => b.at - a.at)
    let cwd: string | null = null
    for (const s of sessions.slice(0, 3)) {
      const c = await cwdOfSession(s.file)
      if (c && projectKey(c) === entry.name) {
        cwd = c
        break
      }
    }
    cwd ??= decodeProjectKey(entry.name, isDir)
    if (!cwd || !isDir(cwd)) continue
    const repo = repoOf(cwd)
    if (!repo) continue
    out.push({ path: cwd, repoRoot: repo.root, ...(repo.repo ? { repo: repo.repo } : {}), sessions: sessions.map((s) => s.at) })
  }
  return out
}

export type SuggestOptions = { now?: number; limit?: number; existing?: string[]; home?: string }

/** Scan `projectsDir` and rank what it finds. */
export async function suggestProjects(projectsDir: string, opts: SuggestOptions = {}): Promise<ProjectSuggestion[]> {
  const sightings = await scanClaudeProjects(projectsDir)
  return rankProjects(sightings, {
    now: opts.now ?? Date.now(),
    limit: opts.limit,
    existing: (opts.existing ?? []).map((p) => path.resolve(p)),
    home: opts.home,
  })
}

/**
 * The workspace's suggestions: its Claude folder (the one its sessions
 * spawn with), minus folders it already has as projects.
 */
export async function projectSuggestionsOp(rt: WorkspaceRuntime, limit?: number): Promise<ProjectSuggestion[]> {
  const projectsDir = path.join(claudeHome(rt.env), 'projects')
  const existing = (await rt.store.projects.list()).map((p) => p.path)
  return suggestProjects(projectsDir, { limit, existing, home: os.homedir() })
}

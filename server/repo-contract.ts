/**
 * The disk side of the repo contract (core/work/contract.ts): find the repo a
 * folder sits in, read its `.junior/junior.md`, and keep the parse until the
 * file changes. Read on every edit call a session makes, so it's a stat and,
 * only when the file moved, a read.
 */
import { stat, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CONTRACT_FILE, CONTRACT_MAX_CHARS, EMPTY_CONTRACT, parseContract, type RepoContract } from '../core/work/contract.js'
import { log } from './log.js'

export type LoadedContract = {
  /** the repo's root: where the contract's paths start */
  root: string
  contract: RepoContract
  /** false when there's no `.junior/junior.md` (the contract is empty) */
  found: boolean
  errors: string[]
}

type Cached = { mtimeMs: number; size: number; parsed: { contract: RepoContract; errors: string[] } }
const cache = new Map<string, Cached>()
const MAX_CACHED = 200

const exists = (p: string) => stat(p).then(
  () => true,
  () => false,
)

/**
 * The repo a folder sits in: the nearest folder up from it holding `.git`
 * (a folder in a checkout, a file in a worktree). The home folder and the
 * filesystem root are never a repo; a folder in no repo is its own root.
 */
export async function repoRootOf(dir: string): Promise<string> {
  const start = path.resolve(dir)
  const home = os.homedir()
  let at = start
  for (let i = 0; i < 40; i++) {
    if (at === home || at === path.parse(at).root) break
    if (await exists(path.join(at, '.git'))) return at
    const up = path.dirname(at)
    if (up === at) break
    at = up
  }
  return start
}

/**
 * The contract of the repo `dir` sits in. A missing or unreadable file is an
 * empty contract. The home folder is never read as a repo: its `.junior/` is
 * Junior's own data folder, not a contract.
 */
export async function readRepoContract(dir: string): Promise<LoadedContract> {
  const root = await repoRootOf(dir)
  if (root === os.homedir() || root === path.parse(root).root) return { root, contract: EMPTY_CONTRACT, found: false, errors: [] }
  const file = path.join(root, CONTRACT_FILE)
  const st = await stat(file).catch(() => null)
  if (!st || !st.isFile()) {
    cache.delete(file)
    return { root, contract: EMPTY_CONTRACT, found: false, errors: [] }
  }
  const hit = cache.get(file)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { root, ...hit.parsed, found: true }
  let parsed: Cached['parsed']
  if (st.size > CONTRACT_MAX_CHARS * 4) parsed = { contract: EMPTY_CONTRACT, errors: [`the file is longer than ${CONTRACT_MAX_CHARS.toLocaleString('en-US')} characters, so it isn't read`] }
  else {
    const text = await readFile(file, 'utf8').catch(() => null)
    parsed = text === null ? { contract: EMPTY_CONTRACT, errors: ["the file couldn't be read"] } : parseContract(text)
  }
  if (parsed.errors.length) log('warn', 'contract', `${file}: ${parsed.errors.slice(0, 5).join('; ')}`)
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string)
  cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, parsed })
  return { root, ...parsed, found: true }
}

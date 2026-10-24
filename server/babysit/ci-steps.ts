/**
 * The disk side of `ci-local-steps`: a worktree's workflow files and the
 * package.json scripts where their steps run, handed to the pure sort in
 * core/babysit/ci-steps.ts.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { localChecks, workingDirs, type LocalChecks, type WorkflowFile } from '../../core/babysit/ci-steps.js'

/**
 * The failing check's CI job, read from the PR's own workflow files in the
 * task's worktree, its steps sorted into plain checks and the rest
 * (core/babysit/ci-steps.ts). Only the checks are named in the prompt.
 */
export async function readLocalChecks(dir: string, check: string, declared: readonly string[] = []): Promise<LocalChecks> {
  const wfDir = path.join(dir, '.github', 'workflows')
  const names = await readdir(wfDir).catch(() => [] as string[])
  const files: WorkflowFile[] = []
  for (const n of names.filter((n) => /\.ya?ml$/i.test(n)).sort()) {
    const text = await readFile(path.join(wfDir, n), 'utf8').catch(() => null)
    if (text !== null) files.push({ path: `.github/workflows/${n}`, text })
  }
  const scripts = new Map<string, string[] | null>()
  for (const d of workingDirs(files)) {
    const raw = await readFile(path.join(dir, d, 'package.json'), 'utf8').catch(() => null)
    let names: string[] | null = null
    try {
      const pkg = raw === null ? null : (JSON.parse(raw) as { scripts?: unknown })
      if (pkg) names = pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts) : []
    } catch {}
    scripts.set(d, names)
  }
  return localChecks(files, check, (d) => scripts.get(d) ?? null, declared)
}

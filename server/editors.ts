/**
 * "Open in…": the editors installed on this Mac, found by bundle id, never
 * configured. Spotlight (`mdfind`) answers first; the usual Applications
 * folders back it up when indexing is off. macOS only: elsewhere the list is
 * empty and only "Reveal" is offered. A single file a session wrote opens the
 * same way, in the editor last used here.
 */
import { execFile } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Editor } from '../shared/protocol.js'

const pExecFile = promisify(execFile)

type Known = Editor & { bundleId: string; app: string }

/** In menu order. JetBrains ships one app per language; each is its own entry. */
const KNOWN: readonly Known[] = [
  { id: 'cursor', name: 'Cursor', bundleId: 'com.todesktop.230313mzl4w4u92', app: 'Cursor.app' },
  { id: 'vscode', name: 'VS Code', bundleId: 'com.microsoft.VSCode', app: 'Visual Studio Code.app' },
  { id: 'vscode-insiders', name: 'VS Code Insiders', bundleId: 'com.microsoft.VSCodeInsiders', app: 'Visual Studio Code - Insiders.app' },
  { id: 'zed', name: 'Zed', bundleId: 'dev.zed.Zed', app: 'Zed.app' },
  { id: 'zed-preview', name: 'Zed Preview', bundleId: 'dev.zed.Zed-Preview', app: 'Zed Preview.app' },
  { id: 'webstorm', name: 'WebStorm', bundleId: 'com.jetbrains.WebStorm', app: 'WebStorm.app' },
  { id: 'intellij', name: 'IntelliJ IDEA', bundleId: 'com.jetbrains.intellij', app: 'IntelliJ IDEA.app' },
  { id: 'intellij-ce', name: 'IntelliJ IDEA CE', bundleId: 'com.jetbrains.intellij.ce', app: 'IntelliJ IDEA CE.app' },
  { id: 'pycharm', name: 'PyCharm', bundleId: 'com.jetbrains.pycharm', app: 'PyCharm.app' },
  { id: 'pycharm-ce', name: 'PyCharm CE', bundleId: 'com.jetbrains.pycharm.ce', app: 'PyCharm CE.app' },
  { id: 'goland', name: 'GoLand', bundleId: 'com.jetbrains.goland', app: 'GoLand.app' },
  { id: 'rubymine', name: 'RubyMine', bundleId: 'com.jetbrains.rubymine', app: 'RubyMine.app' },
  { id: 'rustrover', name: 'RustRover', bundleId: 'com.jetbrains.rustrover', app: 'RustRover.app' },
  { id: 'phpstorm', name: 'PhpStorm', bundleId: 'com.jetbrains.PhpStorm', app: 'PhpStorm.app' },
  { id: 'clion', name: 'CLion', bundleId: 'com.jetbrains.CLion', app: 'CLion.app' },
  { id: 'rider', name: 'Rider', bundleId: 'com.jetbrains.rider', app: 'Rider.app' },
  { id: 'xcode', name: 'Xcode', bundleId: 'com.apple.dt.Xcode', app: 'Xcode.app' },
]

async function installed(e: Known): Promise<boolean> {
  try {
    const { stdout } = await pExecFile('mdfind', [`kMDItemCFBundleIdentifier == '${e.bundleId}'`], { timeout: 4000 })
    if (stdout.trim()) return true
  } catch {
    // Spotlight off or slow: fall through to the folders
  }
  for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
    if (await stat(path.join(dir, e.app)).then(() => true, () => false)) return true
  }
  return false
}

/** Installs change rarely; a new editor shows up within the hour, or on restart. */
const TTL_MS = 60 * 60 * 1000
let cache: { at: number; editors: Promise<Known[]> } | null = null

function detect(): Promise<Known[]> {
  if (process.platform !== 'darwin') return Promise.resolve([])
  if (cache && Date.now() - cache.at < TTL_MS) return cache.editors
  const editors = Promise.all(KNOWN.map(async (e) => ((await installed(e)) ? e : null))).then((r) =>
    r.filter((e): e is Known => e !== null),
  )
  cache = { at: Date.now(), editors }
  return editors
}

export async function detectEditors(): Promise<Editor[]> {
  return (await detect()).map(({ id, name }) => ({ id, name }))
}

/** Whatever the OS opens `target` with: the file manager for a folder, the default app for a file. */
async function osOpen(target: string): Promise<void> {
  if (process.platform === 'darwin') await pExecFile('open', [target])
  else if (process.platform === 'win32') await pExecFile('explorer', [target]).catch(() => {}) // explorer exits 1 on success
  else await pExecFile('xdg-open', [target])
}

/** Open `folder` in an editor found above, or reveal it in the file manager (`finder`). */
export async function openFolderIn(folder: string, editor: string): Promise<void> {
  if (editor === 'finder') return osOpen(folder)
  const known = (await detect()).find((e) => e.id === editor)
  if (!known) throw new Error(`${editor} isn't installed on this machine`)
  await pExecFile('open', ['-b', known.bundleId, folder])
}

/** Show one file in the file manager, selected: `open -R` on a Mac. */
export async function revealFile(file: string): Promise<void> {
  if (process.platform === 'darwin') await pExecFile('open', ['-R', file])
  else if (process.platform === 'win32') await pExecFile('explorer', [`/select,${file}`]).catch(() => {}) // explorer exits 1 on success
  else await pExecFile('xdg-open', [path.dirname(file)])
}

/**
 * Open one file in `editor` when it is installed here, else in the first
 * editor found (Cursor leads the list), else in whatever the OS opens it with.
 */
export async function openFileIn(file: string, editor?: string): Promise<void> {
  const found = await detect()
  const known = found.find((e) => e.id === editor) ?? found[0]
  if (known) await pExecFile('open', ['-b', known.bundleId, file])
  else await osOpen(file)
}

/**
 * `file` (absolute, or relative to `cwd`) as a real path, when it is a file
 * under one of `roots`. Both sides are resolved through symlinks, so neither
 * `..` nor a link pointing out of a project gets a file outside it opened.
 */
export async function openableFile(
  file: string,
  cwd: string,
  roots: readonly string[],
  /** what to say about a file outside every root (the artifact `from:` rule words it its own way) */
  outside = "that file is outside this session's project",
): Promise<string> {
  if (!file) throw new Error('need a file')
  let real: string
  try {
    real = await realpath(path.resolve(cwd, file))
  } catch {
    throw new Error('that file is gone')
  }
  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => null)
    if (realRoot && real.startsWith(realRoot + path.sep)) {
      if (!(await stat(real)).isFile()) throw new Error('that is a folder, not a file')
      return real
    }
  }
  throw new Error(outside)
}

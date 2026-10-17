import os from 'node:os'
import path from 'node:path'
import { pExecFile } from './config.js'

export function expandHome(p: string): string {
  if (!p) return process.cwd()
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return path.resolve(p)
}

/**
 * Open the OS-native folder chooser on the machine running the server, which,
 * since triage is a localhost app, is the user's own desktop. Returns the picked
 * absolute path, or null when the user dismisses the dialog. The picker command
 * exits non-zero on cancel; we treat that as a cancel rather than an error.
 */
export async function pickNativeFolder(): Promise<string | null> {
  const prompt = 'Select a project folder'
  let cmd: string
  let args: string[]
  if (process.platform === 'darwin') {
    cmd = 'osascript'
    args = ['-e', `POSIX path of (choose folder with prompt "${prompt}")`]
  } else if (process.platform === 'win32') {
    cmd = 'powershell'
    args = [
      '-NoProfile',
      '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${prompt}'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath } else { exit 1 }`,
    ]
  } else {
    // Linux/other: prefer zenity, fall back to kdialog. Neither is guaranteed.
    cmd = 'zenity'
    args = ['--file-selection', '--directory', `--title=${prompt}`]
  }
  try {
    const { stdout } = await pExecFile(cmd, args)
    const out = stdout.trim()
    return out ? out : null
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stderr?: string }
    // A missing picker binary (ENOENT) is a real error worth surfacing; a
    // non-zero exit from a present picker is the user cancelling.
    if (e.code === 'ENOENT') {
      if (process.platform === 'linux') {
        try {
          const { stdout } = await pExecFile('kdialog', ['--getexistingdirectory', os.homedir()])
          const out = stdout.trim()
          return out ? out : null
        } catch (err2) {
          const e2 = err2 as NodeJS.ErrnoException
          if (e2.code === 'ENOENT') throw new Error('no folder picker found (install zenity or kdialog)')
          return null
        }
      }
      throw new Error(`folder picker not available (${cmd} not found)`)
    }
    return null
  }
}

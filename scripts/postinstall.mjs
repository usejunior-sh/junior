// node-pty ships a prebuilt `spawn-helper` binary that npm sometimes extracts
// without its execute bit; the first spawn then fails with "posix_spawnp
// failed". Restore the bit so a fresh install can open a terminal.
import { chmodSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

try {
  const require = createRequire(import.meta.url)
  const root = path.dirname(require.resolve('node-pty/package.json'))
  const prebuilds = path.join(root, 'prebuilds')
  for (const dir of readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper')
    try {
      const mode = statSync(helper).mode
      if ((mode & 0o111) === 0) chmodSync(helper, mode | 0o755)
    } catch {
      // no helper on this platform, fine
    }
  }
} catch {
  // node-pty not installed (optional on unsupported platforms), nothing to fix
}

import { writeFileSync, existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { TRIAGE_DIR, checkHealth, pkgVersion } from '../state.js'
import { uninstallLaunchAgent, launchAgentInstalled, launchAgentLoaded } from '../launchd.js'
import { cyan, die, dim, execFileP, green, red, tilde, yellow } from './ui.js'

/**
 * Removing the agent is a decision, and Triage.app puts one back on every
 * launch — so record it. Deleted again by the next explicit `triage install`.
 */
export const OPT_OUT_FILE = path.join(TRIAGE_DIR, 'no-launch-agent')

export async function uninstall() {
  if (process.platform !== 'darwin') die(`${cyan('triage uninstall')} is macOS only`)
  const had = await uninstallLaunchAgent()
  await mkdir(TRIAGE_DIR, { recursive: true }).catch(() => {})
  writeFileSync(OPT_OUT_FILE, `removed by triage uninstall\n`)
  console.log(had ? `${green('✓')} LaunchAgent removed — triage is stopped; ${cyan('triage')} starts it by hand` : `${dim('○')} no LaunchAgent is installed`)
  console.log(dim(`  Triage.app won't put it back. Undo with ${cyan('triage install')}.`))
}

export async function doctor(port: number) {
  let failures = 0
  const check = (ok: boolean | null, label: string, detail: string, fix?: string) => {
    if (ok === false) failures += 1
    const mark = ok === null ? yellow('!') : ok ? green('✓') : red('✗')
    console.log(`${mark} ${label.padEnd(10)} ${detail}${ok === false && fix ? dim(`  → ${fix}`) : ''}`)
  }
  const [major, minor] = process.versions.node.split('.').map(Number)
  check(major > 22 || (major === 22 && minor >= 5), 'node', `${process.versions.node} ${dim(tilde(process.execPath))}`, 'Node 22.5 or newer is required')
  const version = async (bin: string) => (await execFileP(bin, ['--version'])).stdout.trim().split('\n')[0]
  const claude = await version('claude').catch(() => null)
  check(claude !== null, 'claude', claude ?? 'not found on PATH', 'install Claude Code, or fix PATH')
  const gh = await version('gh').catch(() => null)
  check(gh === null ? null : true, 'gh', gh ?? 'not found — GitHub jobs and the GitHub source need it')
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  check(existsSync(claudeDir) ? true : null, 'claude dir', tilde(claudeDir))
  if (process.platform === 'darwin') {
    const installed = launchAgentInstalled()
    const loaded = installed ? await launchAgentLoaded() : false
    check(installed ? loaded : null, 'agent', installed ? (loaded ? 'installed and loaded' : 'installed but not loaded') : `not installed — jobs stop after a reboot`, `triage start (loads it)`)
    if (!installed) console.log(dim(`             install it with ${cyan('triage install')}`))
  }
  const health = await checkHealth(port)
  if (health === 'other') check(false, 'server', `port ${port} is in use by something else`)
  else if (!health) check(false, 'server', `not answering on :${port}`, 'triage')
  else check(health.version === pkgVersion(), 'server', `up on :${port} · v${health.version}${health.version === pkgVersion() ? '' : ` (this CLI is v${pkgVersion()})`}`, 'triage restart')
  if (failures) process.exitCode = 1
}

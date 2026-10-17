import { pkgVersion } from '../state.js'
import { HELP, cyan, die } from './ui.js'

const args = process.argv.slice(2)
export let explicitPort: number | null = null
export let explicitColor: string | null = null
/** `triage install --defer`: write the agent, never restart a running server. */
export let deferInstall = false
/** `triage goal …` flags (`--workspace` serves `triage add` too) */
export const goalFlags: { doneWhen?: string; horizon?: string; state?: string; workspace?: string } = {}
const GOAL_FLAGS: Record<string, keyof typeof goalFlags> = { '--done-when': 'doneWhen', '--horizon': 'horizon', '--state': 'state', '--workspace': 'workspace' }
export const positional: string[] = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--help' || a === '-h') {
    console.log(HELP)
    process.exit(0)
  } else if (a === '--version' || a === '-v') {
    console.log(pkgVersion())
    process.exit(0)
  } else if (a === '--port') {
    explicitPort = Number(args[++i])
  } else if (a.startsWith('--port=')) {
    explicitPort = Number(a.slice('--port='.length))
  } else if (a === '--defer') {
    deferInstall = true
  } else if (a === '--color') {
    explicitColor = args[++i] ?? null
  } else if (a.startsWith('--color=')) {
    explicitColor = a.slice('--color='.length)
  } else if (GOAL_FLAGS[a.split('=')[0]!]) {
    const eq = a.indexOf('=')
    const v = eq > 0 ? a.slice(eq + 1) : args[++i]
    if (v === undefined) die(`${a} needs a value`)
    goalFlags[GOAL_FLAGS[a.split('=')[0]!]!] = v
  } else if (a.startsWith('-')) {
    die(`unknown option ${a} — try ${cyan('triage --help')}`)
  } else {
    positional.push(a)
  }
}
if (explicitColor !== null && !/^#[0-9a-fA-F]{6}$/.test(explicitColor)) {
  die(`--color needs a hex color, e.g. ${cyan('--color #7aa2f7')}`)
}
if (explicitPort !== null && (!Number.isInteger(explicitPort) || explicitPort <= 0 || explicitPort > 65535)) {
  die(`--port needs a port number, e.g. ${cyan('--port 5179')}`)
}
export const command = positional[0] ?? 'start'

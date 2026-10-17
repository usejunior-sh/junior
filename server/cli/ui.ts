import { execFile } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'
import { pkgVersion, DEFAULT_PORT } from '../state.js'

// Dependency-free ANSI. Colors turn off when piped or when NO_COLOR is set.

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
export const bold = paint('1')
export const dim = paint('2')
export const red = paint('31')
export const green = paint('32')
export const yellow = paint('33')
export const cyan = paint('36')

export const execFileP = promisify(execFile)
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')
export const tilde = (p: string) => (p.startsWith(os.homedir()) ? '~' + p.slice(os.homedir().length) : p)

/** Rounded box around pre-styled lines (width measured without ANSI codes). */
export function box(lines: string[]) {
  const width = Math.max(...lines.map((l) => stripAnsi(l).length))
  console.log(dim('╭' + '─'.repeat(width + 4) + '╮'))
  for (const line of lines) {
    const pad = ' '.repeat(width - stripAnsi(line).length)
    console.log(dim('│') + '  ' + line + pad + '  ' + dim('│'))
  }
  console.log(dim('╰' + '─'.repeat(width + 4) + '╯'))
}

export const row = (label: string, value: string) => dim(label.padEnd(9)) + value

export const HELP = `
  ${bold('triage')} ${dim('v' + pkgVersion())} — ranked work inbox for engineers

  ${bold('Usage')}
    ${cyan('triage')}             start the server in the background ${dim('(no-op if running)')}
    ${cyan('triage serve')}       run the server in the foreground
    ${cyan('triage stop')}        stop the background server
    ${cyan('triage restart')}     stop, then start ${dim('(picks up a newly installed version)')}
    ${cyan('triage status')}      show whether the server is running and where
    ${cyan('triage logs')}        print the tail of the server log

  ${bold('Keep it running')} ${dim('(macOS — jobs only run while triage runs)')}
    ${cyan('triage install')}     install a LaunchAgent: starts at login, restarts after a crash
    ${dim('--defer')}            ${dim('write it without restarting a running server (takes effect at next login)')}
    ${cyan('triage uninstall')}   remove the LaunchAgent
    ${cyan('triage doctor')}      check node, claude, gh, the agent, and the server

  ${bold('Workspaces')} ${dim('(.docs/workspaces.md)')}
    ${cyan('triage workspace list')}              list workspaces ${dim('(default marked *)')}
    ${cyan('triage workspace create <name>')}     create a workspace ${dim('(--color #rrggbb)')}
    ${cyan('triage workspace use <name|id>')}     make a workspace the default

  ${bold('Quick capture')} ${dim('(needs the server running)')}
    ${cyan('triage add <title>')}                  file a to-do in the inbox, with you ${dim('(--workspace <name|id>)')}

  ${bold('Goals')} ${dim('(needs the server running)')}
    ${cyan('triage goal create <title> --done-when <text>')}   start a goal ${dim('(--horizon today|until_done|ongoing)')}
    ${cyan('triage goal list')}                    list goals ${dim('(--state plan_ready,waiting_you)')}
    ${cyan('triage goal show <id>')}               a goal with its plan, handoff and latest log

  ${bold('Desktop app')} ${dim('(macOS)')}
    ${cyan('triage app install')}    install Triage.app ${dim('(opens the UI in its own window)')}
    ${cyan('triage app uninstall')}  remove Triage.app

  ${bold('Options')}
    ${cyan('--port <n>')}         port to serve on ${dim(`(default ${DEFAULT_PORT}; PORT env works too)`)}
    ${cyan('--color <hex>')}      workspace color for ${cyan('workspace create')}
    ${cyan('--workspace <id>')}   the workspace ${cyan('goal')} and ${cyan('add')} act in ${dim('(default: the default workspace)')}
    ${cyan('--version')}          print the version
    ${cyan('--help')}             show this help

  ${bold('Files')}
    ${dim('~/.triage/server.log')}        server output when started in the background
    ${dim('~/.triage/server.json')}       pid/port of the last started server
    ${dim('~/.triage/workspaces.json')}   the workspace registry
    ${dim('~/.triage/workspaces/<id>/')}  each workspace's DB and auth material
`

export function die(message: string): never {
  console.error(`${red('✗')} triage: ${message}`)
  process.exit(1)
}

#!/usr/bin/env node
/**
 * `junior`, lifecycle wrapper around the server (server/index.ts).
 *
 *   junior             start the server in the background if it isn't running
 *   junior serve       run the server in the foreground (debugging, launchd)
 *   junior stop        stop the background server
 *   junior restart     stop + start (picks up a newly installed version)
 *   junior status      is it running, where, since when
 *   junior logs        print the tail of ~/.junior/server.log
 *   junior install     keep it running: a macOS LaunchAgent (restarts after reboot/crash)
 *   junior uninstall   remove the LaunchAgent
 *   junior doctor      check the environment jobs depend on
 *   junior goal        create, list and show goals (over the running server)
 *   junior add         file a to-do in the inbox (over the running server)
 *
 * "Is junior running" is always decided by GET /api/health, a pid file can
 * lie after a crash or reboot; the health check cannot. The state file
 * (~/.junior/server.json) only records the port so stop/status/restart can
 * find a server started with --port.
 *
 * Port conflicts fail fast with a message instead of auto-incrementing: the
 * MCP shim and browser bookmarks assume a stable port, so silently moving
 * to 5179 would break every other consumer.
 */
import './migrate-boot.js'
import { spawn } from 'node:child_process'
import { openSync, rmSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { checkHealth, JUNIOR_DIR, LOG_FILE, type Health } from './state.js'
import { launchAgentInstalled, loadLaunchAgent, launchAgentLoaded, installLaunchAgent, launchAgentPlist, kickstartLaunchAgent } from './launchd.js'
import { appCmd } from './cli/app.js'
import { command, deferInstall, positional } from './cli/args.js'
import { addCmd, goalCmd } from './cli/goal.js'
import { logTail, logs, printRunning, resolvePort, status, stop } from './cli/lifecycle.js'
import { OPT_OUT_FILE, doctor, uninstall } from './cli/service.js'
import { bold, box, cyan, die, dim, green, red, row, tilde, yellow } from './cli/ui.js'
import { workspaceCmd } from './cli/workspace.js'

async function start(port: number) {
  const health = await checkHealth(port)
  if (health === 'other') {
    die(
      `port ${port} is in use by something that isn't junior — pick another port: ${cyan(`junior --port ${port + 1}`)}`,
    )
  }
  if (health) {
    printRunning(health, 'is already running')
    return
  }

  if (launchAgentInstalled()) {
    // The LaunchAgent owns the process: load it and wait for health.
    await loadLaunchAgent()
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250))
      const up = await checkHealth(port)
      if (up && up !== 'other') {
        printRunning(up, 'started (LaunchAgent)')
        return
      }
    }
    die(`the LaunchAgent did not bring junior up on port ${port} within 15s — check ${cyan('junior logs')}`)
  }

  await mkdir(JUNIOR_DIR, { recursive: true })
  const logFd = openSync(LOG_FILE, 'a')
  // Re-invoke this same script with `serve`, detached, logging to the file.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, PORT: String(port) },
  })
  let exited: number | null = null
  child.on('exit', (code) => {
    exited = code ?? 1
  })
  child.unref()

  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250))
    if (exited !== null) {
      const tail = await logTail(15)
      console.error(`${red('✗')} junior: server exited before it came up ${dim(`(code ${exited})`)}`)
      if (tail) console.error(dim(tail))
      process.exit(1)
    }
    const up = await checkHealth(port)
    if (up && up !== 'other') {
      printRunning(up, 'started')
      return
    }
  }
  die(`server did not come up on port ${port} within 15s — check ${cyan('junior logs')}`)
}

// keep it running (LaunchAgent)

async function install(port: number) {
  if (process.platform !== 'darwin') die(`${cyan('junior install')} is macOS only — run ${cyan('junior serve')} under your own service manager`)
  const script = fileURLToPath(import.meta.url)
  if (script.endsWith('.ts')) {
    die(`install from the published package, not a dev checkout (${tilde(script)}) — ${cyan('npm i -g usejunior')}, then ${cyan('junior install')}`)
  }
  // A background server started by hand would fight the agent for the port.
  const health = await checkHealth(port)
  const running = !!health && health !== 'other'
  // --defer leaves that server exactly where it is: the plist is written but
  // not loaded, so launchd picks it up at the next login instead of stopping
  // a daemon (and every live session in it) to take ownership now.
  if (!deferInstall && running && !(await launchAgentLoaded())) await stop(port)
  await mkdir(JUNIOR_DIR, { recursive: true })
  // An explicit install is consent: clear any earlier `junior uninstall`.
  rmSync(OPT_OUT_FILE, { force: true })
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: os.homedir() }
  for (const k of ['JUNIOR_HOME', 'JUNIOR_DB', 'CLAUDE_CONFIG_DIR', 'LANG']) if (process.env[k]) env[k] = process.env[k]!
  if (deferInstall) {
    await installLaunchAgent({ node: process.execPath, script, port, logFile: LOG_FILE, env }, { load: false })
    box([
      `${green('●')} ${bold('LaunchAgent written')}`,
      '',
      row('agent', tilde(launchAgentPlist())),
      row('active', running ? yellow('at your next login') : green('now')),
      '',
      dim(running ? 'The server already running was left alone, sessions and all.' : ''),
      `${dim('Remove it with')} ${cyan('junior uninstall')}`,
    ].filter((l) => l !== ''))
    if (!running) await loadLaunchAgent()
    return
  }
  await installLaunchAgent({ node: process.execPath, script, port, logFile: LOG_FILE, env })
  const deadline = Date.now() + 15_000
  let up: Health | null = null
  while (Date.now() < deadline && !up) {
    await new Promise((r) => setTimeout(r, 250))
    const h = await checkHealth(port)
    if (h && h !== 'other') up = h
  }
  box([
    `${green('●')} ${bold('LaunchAgent installed')}`,
    '',
    row('agent', tilde(launchAgentPlist())),
    row('node', tilde(process.execPath)),
    row('server', up ? green(`up on :${port} (pid ${up.pid})`) : yellow(`not answering yet — check ${cyan('junior logs')}`)),
    '',
    dim('junior now starts at login and restarts if it crashes.'),
    `${dim('Remove it with')} ${cyan('junior uninstall')}`,
  ])
}

// dispatch

switch (command) {
  case 'start':
    await start(await resolvePort(true))
    break
  case 'serve':
    // Foreground: hand over to the server module (it listens on import).
    await import('./index.js')
    break
  case 'stop':
    await stop(await resolvePort(false))
    break
  case 'restart': {
    const port = await resolvePort(false)
    if (launchAgentInstalled() && (await launchAgentLoaded())) {
      await kickstartLaunchAgent()
      console.log(`${green('✓')} restarting via the LaunchAgent`)
      await start(port)
      break
    }
    await stop(port)
    await start(port)
    break
  }
  case 'install':
    await install(await resolvePort(true))
    break
  case 'uninstall':
    await uninstall()
    break
  case 'doctor':
    await doctor(await resolvePort(false))
    break
  case 'status':
    await status(await resolvePort(false))
    break
  case 'logs':
    await logs()
    break
  case 'workspace':
  case 'workspaces':
    await workspaceCmd(positional[1], positional[2])
    break
  case 'goal':
  case 'goals':
    await goalCmd(positional[1], positional.slice(2))
    break
  case 'add':
    await addCmd(positional.slice(1))
    break
  case 'app':
    await appCmd(positional[1])
    break
  default:
    die(`unknown command "${command}" — try ${cyan('junior --help')}`)
}

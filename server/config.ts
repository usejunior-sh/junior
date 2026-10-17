import { promisify } from 'node:util'
import { exec, execFile } from 'node:child_process'
import { buildInfo, pkgVersion } from './state.js'

export const PORT = Number(process.env.PORT || 5178)

export const VERSION = pkgVersion()
// Which copy of triage this is (checkout / unreleased build / release), fixed
// for the life of the process, reported everywhere so every surface agrees.
export const BUILD = buildInfo()
export const SERVER_STARTED = Date.now()

export const pExecFile = promisify(execFile)
export const pExec = promisify(exec)

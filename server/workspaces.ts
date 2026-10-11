/**
 * Workspaces (.docs/workspaces.md) — the top-level scope isolating work from
 * personal. Hermes-profile-style storage under a single daemon: each workspace
 * is its own directory holding its own SQLite file, so isolation is physical
 * (a workspace cannot read another's rows), never a WHERE clause.
 *
 *   ~/.triage/
 *     workspaces.json          registry (no secrets)
 *     workspaces/<id>/
 *       triage.db              same schema as ever — no migration needed
 *       .env                   secrets (the provider's API key), mode 0600
 *       <provider>/            private config dir for the config-dir backend
 *
 * A workspace is a provider plus its auth. This module owns the registry file,
 * the directory layout, the one-time migrations (the legacy single DB into the
 * default workspace; workspaces from before providers onto Claude) and what is
 * stored for each auth backend. The provider's adapter turns that into spawn
 * env. It holds no runtime state — the server builds a WorkspaceRuntime per
 * entry on top of this.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { TRIAGE_DIR } from './state.js'
import type { WorkspaceAuthBackend } from '../shared/protocol.js'
import { DEFAULT_PROVIDER, providerFor, toProviderId } from './providers/registry.js'
import type { ProviderAuth, ProviderId } from './providers/types.js'

export type WorkspaceMeta = {
  id: string
  name: string
  /** hex color — the ambient "which world am I in" signal */
  color: string
  description?: string
  /** the coding agent its sessions, runs and probes go through */
  provider: ProviderId
  authBackend: WorkspaceAuthBackend
  createdAt: number
}

export type WorkspaceRegistry = {
  version: 1
  defaultId: string
  /** whether the first-run onboarding modal has been completed (or skipped) */
  onboarded: boolean
  workspaces: WorkspaceMeta[]
}

export const REGISTRY_FILE = path.join(TRIAGE_DIR, 'workspaces.json')
const WORKSPACES_DIR = path.join(TRIAGE_DIR, 'workspaces')
/** the pre-workspaces single-DB location, migrated into the default workspace */
const LEGACY_DB = path.join(TRIAGE_DIR, 'triage-dev.db')

export const workspaceDir = (id: string) => path.join(WORKSPACES_DIR, id)
export const workspaceDbFile = (id: string) => path.join(workspaceDir(id), 'triage.db')

/**
 * Which SQLite file a workspace opens. TRIAGE_DB keeps its pre-workspaces
 * meaning — "the default workspace's DB lives here" — so dev/test overrides
 * keep working; every other workspace always uses its own directory.
 */
export function dbFileFor(id: string, defaultId: string): string {
  if (process.env.TRIAGE_DB && id === defaultId) return process.env.TRIAGE_DB
  return workspaceDbFile(id)
}
export const workspaceEnvFile = (id: string) => path.join(workspaceDir(id), '.env')
/** The private config dir of a config-dir workspace — `claude/` for Claude, as it always was. */
export const workspaceAuthDir = (meta: Pick<WorkspaceMeta, 'id' | 'provider'>) => path.join(workspaceDir(meta.id), meta.provider)

const AUTH_BACKENDS: WorkspaceAuthBackend[] = ['inherit', 'api-key', 'config-dir']

export const toAuthBackend = (v: unknown): WorkspaceAuthBackend | undefined =>
  AUTH_BACKENDS.includes(v as WorkspaceAuthBackend) ? (v as WorkspaceAuthBackend) : undefined

/** "Work stuff!" → "work-stuff"; falls back to a uuid slice for degenerate names. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || `ws-${randomUUID().slice(0, 8)}`
}

export function saveRegistry(reg: WorkspaceRegistry): void {
  mkdirSync(TRIAGE_DIR, { recursive: true })
  writeFileSync(REGISTRY_FILE, JSON.stringify(reg, null, 2) + '\n')
}

/**
 * Load the registry, creating it (and migrating the legacy single DB into the
 * default workspace) on first run. Idempotent; safe to call at every boot.
 */
export function loadRegistry(): WorkspaceRegistry {
  let reg: WorkspaceRegistry | null = null
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as WorkspaceRegistry
    if (parsed && Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0) reg = parsed
  } catch {
    // no registry yet — first run
  }

  if (!reg) {
    reg = {
      version: 1,
      defaultId: 'default',
      onboarded: false,
      workspaces: [
        {
          id: 'default',
          name: 'Default',
          color: '#7aa2f7',
          provider: DEFAULT_PROVIDER,
          authBackend: 'inherit',
          createdAt: Date.now(),
        },
      ],
    }
    saveRegistry(reg)
  }

  if (migrateProviders(reg)) saveRegistry(reg)
  for (const ws of reg.workspaces) ensureWorkspaceDirs(ws.id)
  migrateLegacyDb(reg.defaultId)
  return reg
}

/**
 * Every workspace names its provider. One saved before providers existed ran
 * on Claude, so it gets `claude` — and keeps everything else it had, its
 * config dir included (`claude/` is that provider's dir). True = changed.
 */
export function migrateProviders(reg: WorkspaceRegistry): boolean {
  let changed = false
  for (const ws of reg.workspaces) {
    if (toProviderId(ws.provider)) continue
    ws.provider = DEFAULT_PROVIDER
    changed = true
  }
  return changed
}

export function ensureWorkspaceDirs(id: string): void {
  mkdirSync(workspaceDir(id), { recursive: true })
}

/**
 * One-time migration: the pre-workspaces DB (~/.triage/triage-dev.db, or
 * TRIAGE_DB) moves into the default workspace's directory — with its WAL/SHM
 * siblings — so nothing is lost and the old path stops being written. Skipped
 * when the workspace DB already exists (never clobber) or there is nothing to
 * move.
 */
function migrateLegacyDb(defaultId: string): void {
  if (process.env.TRIAGE_DB) return // override in force — the default workspace uses it in place
  const target = workspaceDbFile(defaultId)
  if (existsSync(target) || !existsSync(LEGACY_DB)) return
  ensureWorkspaceDirs(defaultId)
  renameSync(LEGACY_DB, target)
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(LEGACY_DB + suffix)) renameSync(LEGACY_DB + suffix, target + suffix)
  }
  console.log(`[workspaces] migrated ${LEGACY_DB} → ${target}`)
}

/** Write the workspace's API key to its own .env, owner-read-only, under its provider's name. */
export function writeApiKey(meta: Pick<WorkspaceMeta, 'id' | 'provider'>, key: string): void {
  ensureWorkspaceDirs(meta.id)
  const file = workspaceEnvFile(meta.id)
  writeFileSync(file, `${providerFor(meta.provider).auth.apiKeyVar}=${key}\n`, { mode: 0o600 })
  chmodSync(file, 0o600) // writeFileSync mode is ignored when the file exists
}

function readEnvFile(id: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    for (const line of readFileSync(workspaceEnvFile(id), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m) out[m[1]] = m[2]
    }
  } catch {
    // no .env — fine for inherit/config-dir
  }
  return out
}

const storedApiKey = (meta: Pick<WorkspaceMeta, 'id' | 'provider'>): string | undefined =>
  readEnvFile(meta.id)[providerFor(meta.provider).auth.apiKeyVar]

/** "key set (…abcd)" material for the UI; the key itself never leaves disk. */
export function apiKeyHint(meta: Pick<WorkspaceMeta, 'id' | 'provider'>): string | null {
  const key = storedApiKey(meta)
  return key ? `…${key.slice(-4)}` : null
}

/** What triage keeps for a workspace's auth backend, as its adapter reads it. */
export function authOf(meta: WorkspaceMeta): ProviderAuth {
  if (meta.authBackend === 'api-key') return { backend: 'api-key', apiKey: storedApiKey(meta) }
  if (meta.authBackend === 'config-dir') {
    const dir = workspaceAuthDir(meta)
    mkdirSync(dir, { recursive: true })
    return { backend: 'config-dir', dir }
  }
  return { backend: 'inherit' }
}

/**
 * The env overrides a workspace's subprocesses spawn with, as its provider
 * resolves them. `undefined` for `inherit` — the agent finds its own login.
 * The overrides are merged over process.env at the spawn site.
 */
export function envOverridesFor(meta: WorkspaceMeta): Record<string, string> | undefined {
  return providerFor(meta.provider).auth.env(authOf(meta))
}

/** Full spawn env for a workspace: process.env with the overrides on top. */
export function spawnEnvFor(meta: WorkspaceMeta): Record<string, string> | undefined {
  const overrides = envOverridesFor(meta)
  if (!overrides) return undefined
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  return { ...env, ...overrides }
}

/** The one-time interactive login for a config-dir workspace, shown in the UI. */
export function loginCommandFor(meta: Pick<WorkspaceMeta, 'id' | 'provider'>): string {
  return providerFor(meta.provider).auth.loginCommand(workspaceAuthDir(meta))
}

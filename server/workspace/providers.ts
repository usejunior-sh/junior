import { apiKeyHint, authOf, isConnected, loginCommandFor, providerAuthBackend, workspaceAuthDir, type WorkspaceMeta, writeApiKey } from '../workspaces.js'
import { PROVIDER_IDS, type ProviderStatus, type WorkspaceProvider } from '../../shared/protocol.js'
import { providerFor } from '../providers/registry.js'
import { scanUsage } from '../../core/usage/ledger.js'
import { summarize as summarizeUsage } from '../../core/usage/summary.js'
import type { ProviderId } from '../providers/types.js'
import { log } from '../log.js'
import { WorkspaceRuntime } from './runtime.js'
import { claudeProjectRoots, usageByLogin, workspaceLogin } from '../usage/logins.js'

/** Every agent this build knows, as the workspace has it set up, the primary first. */
export function wireProviders(meta: WorkspaceMeta): WorkspaceProvider[] {
  const ids = [meta.provider, ...PROVIDER_IDS.filter((id) => id !== meta.provider)]
  return ids.map((id) => {
    const authBackend = providerAuthBackend(meta, id)
    return {
      id,
      primary: id === meta.provider,
      connected: authBackend !== undefined,
      ...(authBackend ? { authBackend } : {}),
      ...(authBackend === 'api-key' ? { apiKeyHint: apiKeyHint(meta, id) } : {}),
      ...(authBackend === 'config-dir' ? { configDir: workspaceAuthDir(meta, id), loginCommand: loginCommandFor(meta, id) } : {}),
    }
  })
}

/** How long an account read stands before the next ask goes back to the agent. */
const PROVIDER_STATUS_TTL_MS = 2 * 60_000

/**
 * Each connected agent's account, plan windows and recent use, read from the
 * agent itself. A throwaway subprocess apiece, so cached for a couple of
 * minutes and shared by concurrent askers. Claude's recent spend is the Usage
 * tab's ledger, narrowed to the login this workspace runs on; Codex reports its own.
 */
export function readProviderStatus(rt: WorkspaceRuntime, refresh = false): Promise<ProviderStatus[]> {
  if (!refresh && rt.providerStatus && Date.now() - rt.providerStatus.at < PROVIDER_STATUS_TTL_MS) {
    return Promise.resolve(rt.providerStatus.providers)
  }
  if (rt.providerStatusInFlight) return rt.providerStatusInFlight
  const run = (async () => {
    const connected = wireProviders(rt.meta).filter((p) => p.connected)
    const providers = await Promise.all(
      connected.map(async ({ id }): Promise<ProviderStatus> => {
        const [status, recent] = await Promise.all([
          providerFor(id).account(rt.envFor(id)),
          id === 'claude' ? claudeRecent(rt.meta, 30).catch(() => undefined) : Promise.resolve(undefined),
        ])
        return { id, ...status, ...(recent ? { recent } : {}), checkedAt: Date.now() }
      }),
    )
    rt.providerStatus = { at: Date.now(), providers }
    return providers
  })().finally(() => (rt.providerStatusInFlight = null))
  rt.providerStatusInFlight = run
  return run
}

/** What Claude Code spent over the last `days` days on the login this workspace runs on. */
async function claudeRecent(meta: WorkspaceMeta, days: number): Promise<ProviderStatus['recent']> {
  const now = Date.now()
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const since = start.getTime() - (days - 1) * 86_400_000
  const { entries } = await scanUsage(claudeProjectRoots(), since)
  const { groups } = await usageByLogin(entries)
  const { totals } = summarizeUsage(groups.get(workspaceLogin(meta)) ?? [], since, now)
  return { days, tokens: totals.tokens, costUsd: totals.cost }
}

/**
 * Keep a provider's API key: in the workspace's .env always, and, for an
 * agent that reads it from a login file (Codex), signed into its own home.
 * A key the agent refuses fails the save rather than being stored half-done.
 */
export async function saveProviderKey(meta: WorkspaceMeta, provider: ProviderId, key: string): Promise<void> {
  const { storeKey } = providerFor(provider).auth
  if (storeKey) {
    const auth = authOf({ ...meta, ...(provider === meta.provider ? { authBackend: 'api-key' as const } : { connections: { ...meta.connections, [provider]: { authBackend: 'api-key' as const } } }) }, provider)
    if (auth.backend === 'api-key' && auth.dir) await storeKey(auth.dir, key)
  }
  writeApiKey(meta, key, provider)
}

/**
 * After a non-primary agent's connection changes: its live sessions stop (the
 * next message revives them on the new auth) and its model list is re-read.
 */
export function applyProviderChange(rt: WorkspaceRuntime, provider: ProviderId): void {
  for (const s of rt.live.values()) if (s.provider.id === provider) s.stop()
  rt.modelCache.delete(provider)
  rt.providerStatus = null
  log('info', 'workspaces', `${provider} ${isConnected(rt.meta, provider) ? `connected (${providerAuthBackend(rt.meta, provider)})` : 'disconnected'}`, {
    workspace: rt.meta.id,
  })
}

/**
 * The adapters a workspace can name, by id. A workspace's `provider` is one of
 * these keys; a second adapter is one more entry here.
 */
import { claude } from './claude.js'
import type { Provider, ProviderId } from './types.js'

const PROVIDERS: Record<ProviderId, Provider> = { claude }

/** What a workspace from before providers runs on. */
export const DEFAULT_PROVIDER: ProviderId = 'claude'

export const providerFor = (id: ProviderId): Provider => PROVIDERS[id]

export const toProviderId = (v: unknown): ProviderId | undefined =>
  typeof v === 'string' && Object.hasOwn(PROVIDERS, v) ? (v as ProviderId) : undefined

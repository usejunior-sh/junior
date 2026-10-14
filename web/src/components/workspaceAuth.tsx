/**
 * The workspace's identity and Claude-auth controls, shared by the create /
 * onboarding flow (WorkspaceModal) and the settings page's Workspace and
 * Providers tabs — one set of cards, one verify panel, so the two doors
 * never drift apart.
 */
import { Check, KeyRound, Laptop, RefreshCw, UserRound } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ProviderId, Workspace, WorkspaceAuthBackend, WorkspaceVerifyResponse } from '../../../shared/protocol.js'

export const WORKSPACE_COLORS = ['#7aa2f7', '#9ece6a', '#bb9af7', '#e0af68', '#f7768e', '#2ac3de', '#ff9e64', '#c0caf5']

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="wsColors" role="radiogroup" aria-label="Workspace colour">
      {WORKSPACE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          className={`wsColor${value === c ? ' active' : ''}`}
          style={{ background: c }}
          aria-label={`Colour ${c}`}
          onClick={() => onChange(c)}
        >
          {value === c && <Check size={12} aria-hidden="true" />}
        </button>
      ))}
    </div>
  )
}

type AuthCard = {
  backend: WorkspaceAuthBackend
  icon: typeof Laptop
  title: string
  body: string
}

export const AUTH_CARDS: AuthCard[] = [
  {
    backend: 'inherit',
    icon: Laptop,
    title: 'Use my existing Claude login',
    body: 'The same claude.ai subscription and connectors this machine already uses. Nothing else to set up.',
  },
  {
    backend: 'api-key',
    icon: KeyRound,
    title: 'Claude API key',
    body: 'Billed to this key. No claude.ai connectors in this workspace — Slack jobs won’t run here; GitHub via gh still works.',
  },
  {
    backend: 'config-dir',
    icon: UserRound,
    title: 'Separate claude.ai login',
    body: 'Its own subscription and its own connectors (e.g. a personal Slack). Needs a one-time login in your terminal.',
  },
]

/** The same three backends, as Codex reads them. */
const CODEX_AUTH_CARDS: AuthCard[] = [
  {
    backend: 'inherit',
    icon: Laptop,
    title: 'Use my existing Codex login',
    body: 'Whatever `codex login` set up on this machine (~/.codex) — your ChatGPT plan or key, and its MCP servers.',
  },
  {
    backend: 'api-key',
    icon: KeyRound,
    title: 'OpenAI API key',
    body: 'Billed to this key, per token. Signed into a Codex home of this workspace’s own — no plan limits apply.',
  },
  {
    backend: 'config-dir',
    icon: UserRound,
    title: 'Separate ChatGPT login',
    body: 'Its own Codex home and its own plan (e.g. a personal account). Needs a one-time login in your terminal.',
  },
]

export const PROVIDER_AUTH_CARDS: Record<ProviderId, AuthCard[]> = { claude: AUTH_CARDS, codex: CODEX_AUTH_CARDS }

const KEY_PLACEHOLDER: Record<ProviderId, string> = { claude: 'sk-ant-…', codex: 'sk-…' }

export const authTitle = (backend: WorkspaceAuthBackend, provider: ProviderId = 'claude'): string =>
  PROVIDER_AUTH_CARDS[provider].find((c) => c.backend === backend)?.title ?? backend

/** The three auth cards as a radio group; the API-key card holds its own key field. */
export function AuthCards({
  value,
  onChange,
  apiKey,
  onApiKeyChange,
  apiKeyHint,
  provider = 'claude',
}: {
  provider?: ProviderId
  value: WorkspaceAuthBackend
  onChange: (b: WorkspaceAuthBackend) => void
  apiKey: string
  onApiKeyChange: (k: string) => void
  /** masked tail of a key already stored — the field then reads as "replace", not "required" */
  apiKeyHint?: string | null
}) {
  return (
    <div className="wsAuthCards" role="radiogroup" aria-label="Auth method">
      {PROVIDER_AUTH_CARDS[provider].map((card) => {
        const Icon = card.icon
        const active = value === card.backend
        return (
          <button
            key={card.backend}
            type="button"
            role="radio"
            aria-checked={active}
            className={`wsAuthCard${active ? ' active' : ''}`}
            onClick={() => onChange(card.backend)}
          >
            <span className="wsAuthTitle">
              <Icon size={15} aria-hidden="true" />
              {card.title}
              {card.backend === 'inherit' && <em className="wsDefaultTag">default</em>}
            </span>
            <span className="wsAuthBody">{card.body}</span>
            {card.backend === 'api-key' && active && (
              <span className="wsKeyRow" onClick={(e) => e.stopPropagation()}>
                <input
                  type="password"
                  value={apiKey}
                  placeholder={apiKeyHint ? `key set (${apiKeyHint}) — paste to replace` : KEY_PLACEHOLDER[provider]}
                  onChange={(e) => onApiKeyChange(e.target.value)}
                />
                <small>
                  Stored in this workspace's own <code>.env</code> (0600), never in the database.
                </small>
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export type VerifyState = WorkspaceVerifyResponse | 'probing' | null

/** Run the live probe for a workspace's auth. */
export function verifyWorkspace(id: string): Promise<WorkspaceVerifyResponse> {
  return fetch(`/api/workspaces/verify?id=${encodeURIComponent(id)}`, { method: 'POST' })
    .then((r) => r.json() as Promise<WorkspaceVerifyResponse>)
    .catch((e) => ({ ok: false as const, error: String(e) }))
}

export function VerifyPanel({
  workspace,
  state,
  onRecheck,
  footer,
}: {
  workspace: Workspace
  state: VerifyState
  onRecheck: () => void
  footer?: ReactNode
}) {
  return (
    <div className="wsVerify">
      {workspace.authBackend === 'config-dir' && (
        <div className="wsLogin">
          <p>One-time login for this workspace's own claude.ai account — run in a terminal:</p>
          <code className="wsLoginCmd">{workspace.loginCommand}</code>
        </div>
      )}
      {state === 'probing' || state === null ? (
        <div className="probing">
          <span className="pip" /> Probing with this workspace's auth — starts a Claude subprocess,
          takes a few seconds…
        </div>
      ) : state.ok ? (
        <div className="wsVerifyResults">
          {state.authOk ? (
            <div className="wsVerifyRow ok">
              ✓ Auth working — {state.models.length} model{state.models.length === 1 ? '' : 's'}
              {state.models.length > 0 && (
                <span className="wsVerifyDetail">
                  {state.models
                    .slice(0, 3)
                    .map((m) => m.name)
                    .join(' · ')}
                </span>
              )}
            </div>
          ) : (
            <div className="wsVerifyRow bad">✗ Auth failed{state.authError ? ` — ${state.authError}` : ''}</div>
          )}
          {(() => {
            // Report what the probe actually saw — never assert from the backend
            // choice alone. api-key workspaces normally have zero claude.ai
            // connectors (those ride a claude.ai login), and the probe proves it.
            const claudeAi = state.connectors.filter((c) => c.source === 'claude.ai' && c.status === 'connected')
            if (state.slackConnected) return <div className="wsVerifyRow ok">✓ Slack connected</div>
            if (claudeAi.length > 0)
              return <div className="wsVerifyRow dim">— Slack not connected ({claudeAi.length} claude.ai connector{claudeAi.length === 1 ? '' : 's'} live)</div>
            return (
              <div className="wsVerifyRow dim">
                — No claude.ai connectors{workspace.authBackend === 'api-key' ? ' (they ride a claude.ai login — expected for an API-key workspace; Slack jobs won’t run here)' : ''}
              </div>
            )
          })()}
        </div>
      ) : (
        <div className="wsVerifyRow bad">✗ {state.error}</div>
      )}
      <button
        type="button"
        className="wsRecheck"
        disabled={state === 'probing'}
        onClick={onRecheck}
      >
        <RefreshCw size={13} aria-hidden="true" /> Check again
      </button>
      {footer}
    </div>
  )
}

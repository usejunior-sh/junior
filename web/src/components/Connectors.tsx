/**
 * What a dispatched session can actually reach: the claude.ai connectors and
 * local MCP servers, exactly as a session loads them. Lives in Settings:
 * there is nothing to *do* here beyond looking and re-probing, so it is a
 * read-out, not a destination.
 *
 * The probe is per workspace (it runs with that workspace's Claude auth) and
 * the server caches it. Mounting reads the cache; only the pane's Refresh
 * starts a fresh probe, which spawns a subprocess and takes a few seconds.
 */
import { useCallback, useEffect, useState } from 'react'
import type { Connector, ConnectorsResponse } from '../../../shared/protocol.js'

type LoadState =
  | { phase: 'loading'; probing: boolean }
  | { phase: 'ready'; probedAt: number; connectors: Connector[] }
  | { phase: 'error'; message: string }

/** Usable first, then broken, then not-yet-authorized, then intentional states. */
const STATUS_ORDER = ['connected', 'failed', 'needs-auth', 'pending', 'disabled']

const STATUS_LABEL: Record<string, string> = {
  connected: 'connected',
  'needs-auth': 'needs auth',
  pending: 'pending',
  failed: 'failed',
  disabled: 'disabled',
}

export function ConnectorsPanel({ refreshNonce = 0 }: { refreshNonce?: number }) {
  const [state, setState] = useState<LoadState>({ phase: 'loading', probing: false })

  const load = useCallback(async (refresh: boolean) => {
    setState({ phase: 'loading', probing: refresh })
    try {
      const res = await fetch(`/api/connectors${refresh ? '?refresh=1' : ''}`)
      const body = (await res.json()) as ConnectorsResponse
      if (body.ok) setState({ phase: 'ready', probedAt: body.probedAt, connectors: body.connectors })
      else setState({ phase: 'error', message: body.error })
    } catch (err) {
      setState({ phase: 'error', message: String(err) })
    }
  }, [])

  // Nonce 0 is the mount: take the server's cached probe. Every bump after
  // that is the user asking for a real one.
  useEffect(() => {
    void load(refreshNonce > 0)
  }, [load, refreshNonce])

  return (
    <div className="connPanel">
      {state.phase === 'loading' &&
        (state.probing ? (
          <div className="probing">
            <span className="pip" /> Starting a probe session and connecting servers — this takes a
            few seconds…
          </div>
        ) : (
          <div className="pickerLoading">Loading…</div>
        ))}

      {state.phase === 'error' && <div className="msg error">Probe failed: {state.message}</div>}

      {state.phase === 'ready' && (
        <>
          <Group
            title="claude.ai connectors"
            hint="Managed at claude.ai → Settings → Connectors."
            connectors={state.connectors.filter((c) => c.source === 'claude.ai')}
          />
          <Group
            title="Local MCP servers"
            hint="From ~/.claude settings and installed plugins."
            connectors={state.connectors.filter((c) => c.source === 'local')}
          />
          {state.connectors.length === 0 && (
            <div className="pickerLoading">No connectors — this workspace's Claude auth has none.</div>
          )}
          {state.connectors.some((c) => c.status === 'needs-auth') && (
            <div className="authNote">
              <b>needs auth</b> — authorize once in an interactive <code>claude</code> session
              (<code>/mcp</code>); sessions started here then pick the token up.
            </div>
          )}
          <div className="probedAt">probed {new Date(state.probedAt).toLocaleTimeString()}</div>
        </>
      )}
    </div>
  )
}

function Group({ title, hint, connectors }: { title: string; hint: string; connectors: Connector[] }) {
  if (connectors.length === 0) return null
  const connected = connectors.filter((c) => c.status === 'connected').length
  const sorted = [...connectors].sort((a, b) => {
    const d = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status)
    return d !== 0 ? d : a.name.localeCompare(b.name)
  })
  return (
    <section className="connGroup">
      <header>
        <h3>{title}</h3>
        <span className="count">
          {connected}/{connectors.length} connected
        </span>
      </header>
      <p className="hint">{hint}</p>
      <div className="connList">
        {sorted.map((c) => (
          <div key={`${c.source}:${c.name}`} className="connRow">
            <span className={`connDot ${c.status}`} />
            <span className="connName">{c.name}</span>
            <span className={`connStatus ${c.status}`}>{STATUS_LABEL[c.status] ?? c.status}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

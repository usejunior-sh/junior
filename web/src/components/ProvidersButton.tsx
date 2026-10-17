/**
 * The top bar's Providers button: the workspace's connected agents as a small
 * stack of marks, and on click each one's account, who is signed in, how
 * much of every plan window is gone, with a way into Settings → Providers.
 * Accounts are read when the popover opens, never on page load: each read is
 * a throwaway subprocess per agent.
 */
import * as Popover from '@radix-ui/react-popover'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import type { Workspace } from '../../../shared/protocol.js'
import { loadProviderStatus, useProviderStatus } from '../providerStatus.js'
import { openSettings } from '../settings.js'
import { PROVIDER_LABEL, ProviderIcon } from './ProviderIcon.js'
import { accountLine, ProviderUsage } from './ProviderUsage.js'

export function ProvidersButton({ workspace }: { workspace: Workspace }) {
  const [open, setOpen] = useState(false)
  const status = useProviderStatus(workspace.id, open)
  const connected = workspace.providers.filter((p) => p.connected)
  const others = workspace.providers.filter((p) => !p.connected)
  // Known trouble only: a signed-out agent, or a window nearly spent.
  const attention = status.providers?.some((s) => !s.ok || s.limits.some((l) => l.usedPercent >= 90)) ?? false
  const names = connected.map((p) => PROVIDER_LABEL[p.id]).join(', ')

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`topIcon provStack${open ? ' on' : ''}`}
          title={`Providers: ${names}`}
          aria-label={`Providers: ${names}`}
        >
          {connected.map((p) => (
            <span key={p.id} className="provMark">
              <ProviderIcon provider={p.id} size={13} />
            </span>
          ))}
          {attention && <span className="connDot connecting" aria-hidden="true" />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="provPop" side="bottom" align="end" sideOffset={8} collisionPadding={12}>
          <div className="head">
            <span className="lab">Providers</span>
            <span className="win">{workspace.name}</span>
            <button
              type="button"
              className="iconBtn"
              title="Read the accounts again"
              aria-label="Refresh"
              disabled={status.loading}
              onClick={() => void loadProviderStatus(workspace.id, true)}
            >
              <RefreshCw size={12} aria-hidden="true" className={status.loading ? 'spin' : undefined} />
            </button>
          </div>
          {connected.map((p) => {
            const s = status.providers?.find((x) => x.id === p.id)
            return (
              <div key={p.id} className="provPopRow">
                <div className="provPopHead">
                  <ProviderIcon provider={p.id} size={14} />
                  <b>{PROVIDER_LABEL[p.id]}</b>
                  {p.primary && <span className="provTag">primary</span>}
                  <span className="who" title={s ? accountLine(s) : undefined}>
                    {s ? accountLine(s) : ''}
                  </span>
                </div>
                {s ? <ProviderUsage status={s} /> : <div className="provNone">{status.loading ? 'Reading the account…' : status.error ?? ''}</div>}
              </div>
            )
          })}
          {others.length > 0 && (
            <div className="provPopOff">
              {others.map((p) => (
                <span key={p.id}>
                  <ProviderIcon provider={p.id} size={12} /> {PROVIDER_LABEL[p.id]} isn’t connected
                </span>
              ))}
            </div>
          )}
          <div className="foot">
            <button
              type="button"
              className="btn ghost sm"
              onClick={() => {
                setOpen(false)
                openSettings('providers')
              }}
            >
              {others.length > 0 ? 'Connect providers…' : 'Manage providers…'}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

import * as Switch from '@radix-ui/react-switch'
import { Gauge, Activity, ScrollText, Plug } from 'lucide-react'
import { useState, useEffect } from 'react'
import type { SystemStatus, SystemResponse } from '../../../../shared/protocol.js'
import { modelSupportsFastMode, FAST_MODE_BLURB } from '../../fastMode.js'
import { SHORTCUTS } from '../../keys.js'
import { useModels } from '../../models.js'
import { type SessionDefaults, readSessionDefaults, writeSessionDefaults } from '../../sessionDefaults.js'
import { setSettingsTab } from '../../settings.js'
import { ModelPopover } from '../ModelPopover.js'
import type { SystemTab } from '../SystemModal.js'
import { Loading, Row, Section } from './shared.js'

// Sessions: defaults for new sessions (per browser).

export function SessionsTab() {
  const [d, setD] = useState<SessionDefaults>(() => readSessionDefaults())
  const models = useModels()
  const fastOk = modelSupportsFastMode(models, d.model)

  const update = (patch: Partial<SessionDefaults>) => {
    writeSessionDefaults(patch)
    setD((prev) => ({ ...prev, ...patch }))
  }

  return (
    <>
      <Section
        title="New session defaults"
        hint="What a fresh draft starts with. A session’s own prompt box can still change any of these for that session, and the last pick there becomes the new default."
      >
        <Row label="Model and effort" hint="Leave unset to follow Claude Code’s own default.">
          <ModelPopover model={d.model} effort={d.effort} onModelChange={(model, effort) => update({ model, effort })} />
        </Row>
        <Row
          label="Fast mode"
          hint={fastOk ? FAST_MODE_BLURB : 'The chosen model does not support fast mode.'}
        >
          <Switch.Root
            className="uiSwitch"
            checked={d.fastMode && fastOk}
            disabled={!fastOk}
            onCheckedChange={(on) => update({ fastMode: on })}
            aria-label="Fast mode for new sessions"
          >
            <Switch.Thumb className="uiSwitchThumb" />
          </Switch.Root>
        </Row>
      </Section>
      <Section title="Reset">
        <Row label="Forget these defaults" hint="New sessions go back to Claude Code’s defaults.">
          <button
            type="button"
            className="btn"
            onClick={() => update({ model: undefined, effort: undefined, fastMode: false })}
          >
            Reset
          </button>
        </Row>
      </Section>
    </>
  )
}

// Shortcuts: read-only for now.

export function ShortcutsTab() {
  return (
    <Section title="Keys" hint="Single keys work outside text fields and while no dialog is open. ⌘K works everywhere.">
      <table className="setKeys">
        <tbody>
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={keys}>
              <td>
                <kbd>{keys}</kbd>
              </td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  )
}

// About: the daemon.

export function AboutTab({ onOpenSystem }: { onOpenSystem: (t: SystemTab) => void }) {
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void fetch('/api/system')
      .then((r) => r.json() as Promise<SystemResponse>)
      .then((b) => (b.ok ? setStatus(b.status) : setError(b.error)))
      .catch((e) => setError(String(e)))
  }, [])

  return (
    <>
      <Section title="triage" hint="A local web UI over the Claude Agent SDK. Everything runs on this machine; the daemon answers only this Mac (and phones you pair under Phone) and holds no Slack or GitHub credentials.">
        {error && <div className="msg error">{error}</div>}
        {status && (
          <>
            <div className="setKv">
              <span className="k">version</span>
              <span className="v">{status.version}</span>
            </div>
            <div className="setKv">
              <span className="k">port</span>
              <span className="v">{status.port}</span>
            </div>
            <div className="setKv">
              <span className="k">workspace</span>
              <span className="v">{status.workspace}</span>
            </div>
            <div className="setKv">
              <span className="k">database</span>
              <span className="v" title={status.db}>{status.db}</span>
            </div>
            <div className="setKv">
              <span className="k">logs</span>
              <span className="v" title={status.logDir ?? undefined}>{status.logDir ?? 'in-memory only'}</span>
            </div>
            <div className="setKv">
              <span className="k">live sessions</span>
              <span className="v">{status.liveSessions}</span>
            </div>
          </>
        )}
        {!status && !error && <Loading />}
      </Section>
      <Section title="Under the hood" hint="The daemon’s status sheet, and the diagnostics tabs here.">
        <div className="setActions">
          <button type="button" className="btn" onClick={() => onOpenSystem('status')}>
            <Gauge size={13} aria-hidden="true" /> Status
          </button>
          <button type="button" className="btn" onClick={() => setSettingsTab('activity')}>
            <Activity size={13} aria-hidden="true" /> Activity
          </button>
          <button type="button" className="btn" onClick={() => setSettingsTab('logs')}>
            <ScrollText size={13} aria-hidden="true" /> Logs
          </button>
          <button type="button" className="btn ghost" onClick={() => setSettingsTab('connectors')}>
            <Plug size={13} aria-hidden="true" /> Connectors
          </button>
        </div>
      </Section>
    </>
  )
}

import { useState, useEffect } from 'react'
import type { ConnectorsResponse } from '../../../../shared/protocol.js'
import { setSettingsTab } from '../../settings.js'
import { MAX_GOAL_TEAM } from '../../../../core/goals/types.js'
import { RepoScopeEditor } from '../RepoScope.js'
import { Row, Section, useWorkspaceSettings } from './shared.js'

// Sources: GitHub scope, connectors. The jobs switch lives under Automations.

export function SourcesTab() {
  const [connectors, setConnectors] = useState<{ total: number; connected: number; slack: boolean } | 'loading' | 'error'>(
    'loading',
  )
  useEffect(() => {
    // The server hands back its cached probe; no subprocess is started for this.
    void fetch('/api/connectors')
      .then((r) => r.json() as Promise<ConnectorsResponse>)
      .then((b) => {
        if (!b.ok) return setConnectors('error')
        const live = b.connectors.filter((c) => c.status === 'connected')
        setConnectors({
          total: b.connectors.length,
          connected: live.length,
          slack: live.some((c) => /slack/i.test(c.name)),
        })
      })
      .catch(() => setConnectors('error'))
  }, [])

  return (
    <>
      <Section
        title="GitHub repos"
        hint="The GitHub source only pulls from the repos checked here, and the scope is per workspace. Nothing checked means no GitHub items in this inbox."
      >
        <RepoScopeEditor onSaved={() => {}} />
      </Section>

      <Section
        title="Slack and connectors"
        hint="Slack jobs run through the claude.ai Slack connector on this workspace’s Claude login. Connectors are managed at claude.ai and in ~/.claude; this is the read-out."
      >
        <Row
          label="Connectors a session can reach"
          hint={
            connectors === 'loading'
              ? 'Reading the last probe…'
              : connectors === 'error'
                ? 'The probe could not be read.'
                : `${connectors.connected} of ${connectors.total} connected · Slack ${connectors.slack ? 'connected' : 'not connected'}`
          }
        >
          <button type="button" className="btn" onClick={() => setSettingsTab('connectors')}>
            See connectors
          </button>
        </Row>
      </Section>
    </>
  )
}

/** The max team size: the most workers one goal runs side by side (a plan's team section is held to it). */
export function GoalTeamSection() {
  const { settings, error, save } = useWorkspaceSettings()
  const [size, setSize] = useState('')
  useEffect(() => {
    if (settings) setSize(String(settings.goalsMaxTeam))
  }, [settings])
  return (
    <Section
      title="Goal teams"
      hint="Junior proposes each goal's team in its plan — who, how many, and why — and independent steps run side by side, each on its own branch."
    >
      <Row label="Max team size" hint="The most workers one goal runs at once. A plan that asks for more is sent back to Junior.">
        <input
          className="setNum"
          type="number"
          min={1}
          max={MAX_GOAL_TEAM}
          value={size}
          disabled={!settings}
          aria-label="Max team size"
          onChange={(e) => setSize(e.target.value)}
          onBlur={() => {
            const n = Number(size)
            if (settings && Number.isInteger(n) && n >= 1 && n <= MAX_GOAL_TEAM && n !== settings.goalsMaxTeam) void save({ goalsMaxTeam: n })
            else if (settings) setSize(String(settings.goalsMaxTeam))
          }}
        />
      </Row>
      {error && <div className="msg error">{error}</div>}
    </Section>
  )
}

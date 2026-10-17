import * as Switch from '@radix-ui/react-switch'
import { useState, useEffect } from 'react'
import type { ConnectorsResponse } from '../../../../shared/protocol.js'
import { setSettingsTab } from '../../settings.js'
import { MAX_GOAL_TEAM } from '../../../../core/goals/types.js'
import { RepoScopeEditor } from '../RepoScope.js'
import { Row, Section, useWorkspaceSettings } from './shared.js'

// Sources: GitHub scope, connectors.

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

      <JobsSwitchSection />

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

/** The global jobs switch, off by default in 0.7 (.docs/next-version.md), and default run limits. */
function JobsSwitchSection() {
  const { settings, error, save } = useWorkspaceSettings()
  const [timeoutMin, setTimeoutMin] = useState('')
  const [budget, setBudget] = useState('')
  useEffect(() => {
    if (!settings) return
    setTimeoutMin(String(Math.round(settings.jobTimeoutMs / 60_000)))
    setBudget(settings.jobBudgetUsd != null ? String(settings.jobBudgetUsd) : '')
  }, [settings])
  const saveTimeout = () => {
    const n = Number(timeoutMin)
    if (Number.isFinite(n) && n >= 1 && n <= 60 && settings && Math.round(n * 60_000) !== settings.jobTimeoutMs) void save({ jobTimeoutMs: Math.round(n * 60_000) })
  }
  const saveBudget = () => {
    const b = budget.trim() ? Number(budget) : null
    if (b === null || (Number.isFinite(b) && b > 0 && b <= 100)) void save({ jobBudgetUsd: b })
  }
  return (
    <Section
      title="Jobs"
      hint="Scheduled scans that file work items on their own. Off by default: add items by hand or by pasting a link, and switch this on once the briefs you queue by hand have earned it."
    >
      <Row label="Run jobs on a schedule" hint={settings?.jobsEnabled ? 'Due jobs run every minute tick.' : 'The scheduler skips every job. “Run now” on a job still works.'}>
        <Switch.Root
          className="uiSwitch"
          checked={settings?.jobsEnabled ?? false}
          disabled={!settings}
          onCheckedChange={(on) => void save({ jobsEnabled: on })}
          aria-label="Run jobs on a schedule"
        >
          <Switch.Thumb className="uiSwitchThumb" />
        </Switch.Root>
      </Row>
      <Row label="Default timeout" hint="Minutes a job run may take before it is stopped and recorded as timed out. A job can set its own.">
        <input className="setNum" inputMode="numeric" value={timeoutMin} disabled={!settings} onChange={(e) => setTimeoutMin(e.target.value)} onBlur={saveTimeout} aria-label="Default job timeout in minutes" />
      </Row>
      <Row label="Default budget per run" hint="Dollars a job run may spend before it stops. Blank = no cap. A job can set its own.">
        <input className="setNum" inputMode="decimal" value={budget} placeholder="none" disabled={!settings} onChange={(e) => setBudget(e.target.value)} onBlur={saveBudget} aria-label="Default job budget in dollars" />
      </Row>
      {error && <div className="msg error">{error}</div>}
    </Section>
  )
}

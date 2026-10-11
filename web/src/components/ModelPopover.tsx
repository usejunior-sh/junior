/**
 * One control for how a session thinks: agent, model and effort. The chip reads
 * "Opus · high"; the popover holds a rail of agents (Claude, Codex) on the left,
 * that agent's filterable model list, who is paying, and effort as a segmented
 * row with the levels a model cannot do struck through. Fast mode stays its own chip.
 */
import * as Popover from '@radix-ui/react-popover'
import { Check, ChevronDown, Search, Sparkles } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  EFFORT_LEVELS,
  PROVIDER_IDS,
  type EffortLevel,
  type ModelOption,
  type ProviderId,
  type WorkspaceAuthBackend,
} from '../../../shared/protocol.js'
import { openSettings } from '../settings.js'
import { useWorkspaceId, useWorkspaces } from '../hooks.js'
import { EFFORT_LABEL, findModel, reloadProviderModels, useProviderModels } from '../models.js'
import { isMobile } from '../useMobile.js'
import { PROVIDER_LABEL, ProviderIcon } from './ProviderIcon.js'

type Props = {
  /** The current model — an alias the user picked, or the wire id the SDK reported. */
  model?: string
  effort?: EffortLevel
  /** `undefined` on either side means "whatever the agent defaults to". */
  onModelChange: (model: string | undefined, effort: EffortLevel | undefined) => void
  /**
   * The agent the models are for. Given → the rail shows; absent → Claude, no
   * rail (the Settings default picker).
   */
  provider?: ProviderId
  /** Given → the rail can switch agents (a draft). Absent → it is locked: a session keeps its agent. */
  onProviderChange?: (provider: ProviderId) => void
  disabled?: boolean
}

const AUTH_LABEL: Record<ProviderId, Record<WorkspaceAuthBackend, string>> = {
  claude: { inherit: 'your Claude login', 'api-key': 'an API key', 'config-dir': "this workspace's own Claude login" },
  codex: { inherit: 'your Codex login', 'api-key': 'an OpenAI API key', 'config-dir': "this workspace's own Codex login" },
}

export function ModelPopover({
  model,
  effort,
  onModelChange,
  provider,
  onProviderChange,
  disabled,
}: Props) {
  const agent = provider ?? 'claude'
  const { all: models, pickable, status } = useProviderModels(agent, model)
  const workspaces = useWorkspaces()
  const workspaceId = useWorkspaceId()
  const workspace = workspaces.find((w) => w.id === workspaceId)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')

  const selected = findModel(models, model)
  // No model on a Codex session means Codex's own default, which it lists first.
  // Named in the chip and used for effort, never sent back as a pick.
  const named = selected ?? (agent !== 'claude' && !model ? models[0] : undefined)
  const efforts = named?.efforts ?? []

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? pickable.filter((m) => `${m.name} ${m.description}`.toLowerCase().includes(needle)) : pickable
  }, [pickable, q])

  function pickModel(m: ModelOption) {
    // A model that cannot do the current effort level drops it rather than
    // carrying a setting the next turn would silently ignore.
    const keep = effort && m.efforts.includes(effort) ? effort : undefined
    onModelChange(m.id, keep)
  }

  function pickEffort(level: EffortLevel | undefined) {
    // `selected.id` rather than `model`: when nothing was ever picked, `model`
    // is the wire id the SDK reported, and passing it back would silently pin
    // the session to that exact model instead of leaving it on the default.
    onModelChange(selected?.id ?? model, level)
  }

  // An agent this workspace isn't connected to is shown, but picking it goes
  // to Settings → Providers instead. Unknown (no workspace yet) counts as connected.
  const connected = (p: ProviderId) => workspace?.providers?.find((w) => w.id === p)?.connected ?? true
  const agentAuth = workspace?.providers?.find((w) => w.id === agent)

  function pickProvider(p: ProviderId) {
    if (p === agent || !onProviderChange) return
    if (!connected(p)) {
      setOpen(false)
      openSettings('providers')
      return
    }
    setQ('')
    onProviderChange(p)
  }

  const label = named?.name ?? (models.length ? 'Model' : status === 'error' ? 'Models unavailable' : 'Loading models…')
  const agentDefault = agent === 'claude' ? 'Claude Code' : PROVIDER_LABEL[agent]

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQ('')
        else if (status === 'error') void reloadProviderModels(agent, true)
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="chip model"
          // A rail can still switch to an agent whose list loads, so only a
          // rail-less picker waits for its models.
          disabled={disabled || (models.length === 0 && status === 'loading' && !onProviderChange)}
          title="Agent, model and effort for this session"
          aria-label={`${agent !== 'claude' ? `${PROVIDER_LABEL[agent]} · ` : ''}Model: ${label}${effort ? `, ${EFFORT_LABEL[effort].toLowerCase()} effort` : ''}`}
        >
          {agent === 'claude' ? <Sparkles size={12} aria-hidden="true" /> : <ProviderIcon provider={agent} size={12} />}
          <span className="name">{label}</span>
          {effort && <span className="eff">{EFFORT_LABEL[effort].toLowerCase()}</span>}
          <ChevronDown size={11} aria-hidden="true" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className={`mpop${provider ? ' withRail' : ''}`}
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          // Desktop: Radix focuses the search box, the first thing in here. A
          // phone would pop its keyboard over the list — show the current
          // model instead.
          onOpenAutoFocus={(e) => {
            if (!isMobile()) return
            e.preventDefault()
            requestAnimationFrame(() => document.querySelector('.mpOpt.sel')?.scrollIntoView({ block: 'nearest' }))
          }}
        >
          {provider && (
            <div className="mpRail" role="radiogroup" aria-label="Agent">
              {PROVIDER_IDS.map((p) => {
                const on = p === agent
                const locked = !onProviderChange && !on
                const off = !on && !connected(p)
                return (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={locked}
                    className={`mpAgent${on ? ' on' : ''}${off ? ' off' : ''}`}
                    title={
                      locked
                        ? `A session keeps its agent — start a new session to use ${PROVIDER_LABEL[p]}`
                        : off
                          ? `${PROVIDER_LABEL[p]} isn’t connected — connect it in Settings → Providers`
                          : PROVIDER_LABEL[p]
                    }
                    onClick={() => pickProvider(p)}
                  >
                    <ProviderIcon provider={p} size={18} />
                    <span>{PROVIDER_LABEL[p]}</span>
                    {off && !locked && <em>Connect</em>}
                  </button>
                )
              })}
            </div>
          )}
          <div className="mpMain">
            <label className="mpSearch">
              <Search size={13} aria-hidden="true" />
              <input
                id="modelSearch"
                placeholder="Search models…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>

            {workspace && (
              <div className="mpAuth">
                {agent === 'claude' ? (
                  <span className="dot sm" style={{ background: workspace.color }} aria-hidden="true" />
                ) : (
                  <ProviderIcon provider={agent} size={12} />
                )}
                <span>
                  Runs on {AUTH_LABEL[agent][agentAuth?.authBackend ?? 'inherit']}
                  {agentAuth?.authBackend === 'api-key' && agentAuth.apiKeyHint ? ` (${agentAuth.apiKeyHint})` : ''}
                </span>
                <span className="pill mute">{workspace.name}</span>
              </div>
            )}

            <div className="mpList" role="listbox" aria-label="Model">
              {shown.map((m) => {
                const on = m === selected
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={`mpOpt${on ? ' sel' : ''}`}
                    onClick={() => pickModel(m)}
                  >
                    <span className="n">{m.name}</span>
                    <span className="d">{m.description}</span>
                    <Check size={13} aria-hidden="true" className="chk" />
                  </button>
                )
              })}
              {shown.length === 0 && (
                <div className="mpEmpty">
                  {models.length === 0 && status === 'loading' ? (
                    `Loading ${PROVIDER_LABEL[agent]} models…`
                  ) : models.length === 0 ? (
                    <>
                      Could not load {PROVIDER_LABEL[agent]} models.{' '}
                      <button type="button" className="btn ghost sm" onClick={() => void reloadProviderModels(agent, true)}>
                        Retry
                      </button>
                    </>
                  ) : pickable.length === 0 ? (
                    'Every model is hidden — pick some in Settings → Models.'
                  ) : (
                    'No model matches.'
                  )}
                </div>
              )}
            </div>

            <div className="mpFoot" role="radiogroup" aria-label="Effort">
              <span className="lbl">Effort</span>
              <button
                type="button"
                role="radio"
                aria-checked={!effort}
                className={`eff${!effort ? ' on' : ''}`}
                title={`Whatever ${agentDefault} defaults to`}
                onClick={() => pickEffort(undefined)}
              >
                Default
              </button>
              {EFFORT_LEVELS.map((level) => {
                const can = efforts.length === 0 || efforts.includes(level)
                return (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={effort === level}
                    disabled={!can}
                    className={`eff${effort === level ? ' on' : ''}${can ? '' : ' blocked'}`}
                    title={can ? EFFORT_LABEL[level] : `${named?.name ?? 'This model'} does not offer ${EFFORT_LABEL[level].toLowerCase()}`}
                    onClick={() => pickEffort(level)}
                  >
                    {EFFORT_LABEL[level]}
                  </button>
                )
              })}
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

import { Check, ChevronDown, ListChecks, Workflow, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  EffortLevel,
  ImageAttachment,
  Mention,
  FastModeDisabledReason,
  FastModeState,
  Project,
  ProviderId,
  ProjectsResponse,
  SessionStatus,
} from '../../../shared/protocol.js'
import { composerDrafts, useComposerDraft } from '../composerDrafts.js'
import { usePersona } from '../junior.js'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/Menu.js'
import { PromptBox } from './PromptBox.js'
import { PromptHead } from './PromptHead.js'

type Props = {
  /** The live session this composer steers: keys its unsent draft. */
  sessionId: string
  status: SessionStatus
  cwd: string
  projectId?: string
  branch?: string
  model?: string
  effort?: EffortLevel
  fastMode?: boolean
  fastModeState?: FastModeState
  fastModeDisabledReason?: FastModeDisabledReason
  /** Plan mode is on: Junior plans, edits nothing, until you approve the plan. */
  planning?: boolean
  /** Ultracode is on: big jobs run as Workflow runs across many agents. */
  ultracode?: boolean
  /** The agent the session runs on: shown, never changed: a session keeps its agent. */
  provider: ProviderId
  /** `mode: 'goal'`: sent in Goal mode */
  onSend: (text: string, images?: ImageAttachment[], mentions?: Mention[], mode?: 'goal', files?: string[]) => void
  /** Plan mode on or off: here only off: the Planning chip's way out */
  onPlanningChange: (planning: boolean) => void
  /** Ultracode on or off: here only off: the Ultracode chip's way out. Runs already going carry on. */
  onUltracodeChange?: (on: boolean) => void
  /** The session has run in Ultracode at some point: off, its chip stays (muted) so it can come back on. */
  ultracodeEver?: boolean
  onInterrupt: () => void
  onModelChange: (model: string | undefined, effort: EffortLevel | undefined) => void
  onFastModeChange: (fastMode: boolean) => void
}

/**
 * The session composer: the same prompt box the draft tab uses, headed by the
 * folder the session runs in, plus the interrupt button while a turn is live.
 */
export function Composer({
  sessionId,
  status,
  cwd,
  projectId,
  branch,
  model,
  effort,
  fastMode,
  fastModeState,
  fastModeDisabledReason,
  planning,
  ultracode,
  provider,
  onSend,
  onPlanningChange,
  onUltracodeChange,
  ultracodeEver,
  onInterrupt,
  onModelChange,
  onFastModeChange,
}: Props) {
  // The unsent draft lives in a per-session store, not local state, so leaving
  // this session for another tab and coming back keeps what you had typed.
  const text = useComposerDraft(sessionId)
  const setText = useCallback((next: string) => composerDrafts.set(sessionId, next), [sessionId])
  const [projects, setProjects] = useState<Project[]>([])
  const running = status === 'running' || status === 'starting'
  const persona = usePersona()
  // Plan and Ultracode are Claude's; another agent never shows their chips.
  const claude = (provider ?? 'claude') === 'claude'
  const showPlanning = !!planning && claude
  const showUltracode = !!ultracode && claude && !!onUltracodeChange
  const ultracodeChip = claude && !!onUltracodeChange && (!!ultracode || !!ultracodeEver)

  // Only to name the project in the header. The folder itself is already fixed.
  useEffect(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [])

  // `/remember` saves to the session's project (stored, not derived from a worktree's folder).
  const project = projectId ? projects.find((p) => p.id === projectId) : projects.find((p) => p.path === cwd)
  const remember = useMemo(() => ({ project: project ? { id: project.id, name: project.name } : null }), [project?.id, project?.name])

  return (
    <PromptBox
      draftKey={sessionId}
      remember={remember}
      head={<PromptHead projects={projects} cwd={cwd} projectId={projectId} branch={branch} />}
      cwd={cwd}
      text={text}
      onTextChange={setText}
      placeholder={
        showPlanning
          ? `What should ${persona.name} plan? It edits nothing until you approve the plan.`
          : running
            ? 'Steer the session… (queued until this turn ends)'
            : showUltracode
              ? `Describe a big job. ${persona.name} splits it across agents and checks the results.`
              : 'Steer the session…'
      }
      sendTitle="Send (Enter)"
      onSubmit={(trimmed, images, mentions, files) => {
        onSend(trimmed, images, mentions, undefined, files)
        setText('')
      }}
      // No mode picker once a session has started: Junior can plan, start a goal or set up a job from
      // what you say. Plan mode and Ultracode still show while they hold, each with a way out.
      status={
        showPlanning || ultracodeChip ? (
          <>
            {showPlanning && (
              <button type="button" className="chip sessionMode plan planning" onClick={() => onPlanningChange(false)} title={`${persona.name} is planning: it edits nothing until you approve the plan. Click to stop planning.`} aria-label="Stop planning">
                <ListChecks size={13} aria-hidden="true" />
                <span className="name">Planning</span>
                <X size={12} aria-hidden="true" />
              </button>
            )}
            {ultracodeChip && (
              // A menu, not a one-click switch: a stray click mustn't drop the mode, and off can come back on.
              <Menu>
                <MenuTrigger asChild>
                  <button type="button" className={`chip sessionMode ${showUltracode ? 'ultracode ultracodeOn' : 'normal ultracodeOff'}`} aria-label={`Ultracode: ${showUltracode ? 'on' : 'off'}`} title={showUltracode ? `Ultracode is on: ${persona.name} fans big jobs out to many agents.` : 'Ultracode is off for this session.'}>
                    <Workflow size={13} aria-hidden="true" />
                    <span className="name">{showUltracode ? 'Ultracode' : 'Ultracode off'}</span>
                    <ChevronDown size={12} aria-hidden="true" />
                  </button>
                </MenuTrigger>
                <MenuContent className="perm" side="top" align="start">
                  <MenuItem className={`wrap mode-ultracode${showUltracode ? ' on' : ''}`} onSelect={() => !showUltracode && onUltracodeChange!(true)}>
                    <Workflow className="modeIcon" size={14} aria-hidden="true" />
                    <span className="text">
                      <span className="name">Ultracode on</span>
                      <span className="desc">Big jobs fan out to many agents at once. Costs more.</span>
                    </span>
                    {showUltracode && <Check className="check" size={14} aria-hidden="true" />}
                  </MenuItem>
                  <MenuItem className={`wrap${showUltracode ? '' : ' on'}`} onSelect={() => showUltracode && onUltracodeChange!(false)}>
                    <X className="modeIcon" size={14} aria-hidden="true" />
                    <span className="text">
                      <span className="name">Ultracode off</span>
                      <span className="desc">One agent at a time. Runs already going carry on.</span>
                    </span>
                    {!showUltracode && <Check className="check" size={14} aria-hidden="true" />}
                  </MenuItem>
                </MenuContent>
              </Menu>
            )}
          </>
        ) : undefined
      }
      model={model}
      effort={effort}
      fastMode={fastMode}
      fastModeState={fastModeState}
      fastModeDisabledReason={fastModeDisabledReason}
      onModelChange={onModelChange}
      provider={provider}
      onFastModeChange={onFastModeChange}
      running={running}
      onInterrupt={onInterrupt}
    />
  )
}

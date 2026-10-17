import { ListChecks, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type {
  EffortLevel,
  ImageAttachment,
  Mention,
  FastModeDisabledReason,
  FastModeState,
  PermissionMode,
  Project,
  ProviderId,
  ProjectsResponse,
  SessionStatus,
} from '../../../shared/protocol.js'
import { composerDrafts, useComposerDraft } from '../composerDrafts.js'
import { PromptBox } from './PromptBox.js'
import { PromptHead } from './PromptHead.js'

type Props = {
  /** The live session this composer steers — keys its unsent draft. */
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
  permissionMode?: PermissionMode
  /** Plan mode is on: Junior plans, edits nothing, until you approve the plan. */
  planning?: boolean
  /** The agent the session runs on — shown, never changed: a session keeps its agent. */
  provider: ProviderId
  /** `mode: 'goal'` — sent in Goal mode */
  onSend: (text: string, images?: ImageAttachment[], mentions?: Mention[], mode?: 'goal') => void
  /** Plan mode on or off — here only off: the Planning chip's way out */
  onPlanningChange: (planning: boolean) => void
  onInterrupt: () => void
  onModelChange: (model: string | undefined, effort: EffortLevel | undefined) => void
  onFastModeChange: (fastMode: boolean) => void
  onPermissionModeChange: (mode: PermissionMode) => void
}

/**
 * The session composer — the same prompt box the draft tab uses, headed by the
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
  permissionMode,
  planning,
  provider,
  onSend,
  onPlanningChange,
  onInterrupt,
  onModelChange,
  onFastModeChange,
  onPermissionModeChange,
}: Props) {
  // The unsent draft lives in a per-session store, not local state, so leaving
  // this session for another tab and coming back keeps what you had typed.
  const text = useComposerDraft(sessionId)
  const setText = useCallback((next: string) => composerDrafts.set(sessionId, next), [sessionId])
  const [projects, setProjects] = useState<Project[]>([])
  const running = status === 'running' || status === 'starting'

  // Only to name the project in the header — the folder itself is already fixed.
  useEffect(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [])

  return (
    <PromptBox
      draftKey={sessionId}
      head={<PromptHead projects={projects} cwd={cwd} projectId={projectId} branch={branch} />}
      cwd={cwd}
      text={text}
      onTextChange={setText}
      placeholder={
        planning ? 'What should Junior plan? It edits nothing until you approve the plan.' : running ? 'Steer the session… (queued until this turn ends)' : 'Steer the session…'
      }
      sendTitle="Send (Enter)"
      onSubmit={(trimmed, images, mentions) => {
        onSend(trimmed, images, mentions)
        setText('')
      }}
      // No mode picker once a session has started: Junior can plan, start a goal or set up a job from
      // what you say. Plan mode still shows while it holds, with a way out.
      status={
        planning && (provider ?? 'claude') === 'claude' ? (
          <button type="button" className="chip sessionMode plan planning" onClick={() => onPlanningChange(false)} title="Junior is planning: it edits nothing until you approve the plan. Click to stop planning." aria-label="Stop planning">
            <ListChecks size={13} aria-hidden="true" />
            <span className="name">Planning</span>
            <X size={12} aria-hidden="true" />
          </button>
        ) : undefined
      }
      model={model}
      effort={effort}
      fastMode={fastMode}
      fastModeState={fastModeState}
      fastModeDisabledReason={fastModeDisabledReason}
      permissionMode={permissionMode}
      onModelChange={onModelChange}
      provider={provider}
      onFastModeChange={onFastModeChange}
      onPermissionModeChange={onPermissionModeChange}
      running={running}
      onInterrupt={onInterrupt}
    />
  )
}

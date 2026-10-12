import { GitBranch } from 'lucide-react'
import type { ReactNode } from 'react'
import type { Project } from '../../../shared/protocol.js'
import { projectColor } from '../tabs.js'
import { choosesProject, ProjectPicker } from './ProjectPicker.js'

type Props = {
  projects: readonly Project[]
  cwd: string
  /** the session's project — its folder may be a worktree, which no project's path matches */
  projectId?: string
  branch?: string | null
  /** Omitted once the session exists — a running session's folder is fixed. */
  onPick?: (cwd: string) => void
  /** a checkout picker, shown instead of the plain branch (draft composer, git projects) */
  checkout?: ReactNode
  /** the folder to show when it isn't `cwd` — a picked worktree, or a note that one will be made */
  where?: string
}

/** `/Users/you/Code/x` → `~/Code/x` — display only. */
const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

/** Where the prompt runs: project, branch, folder. The header of the prompt box. */
export function PromptHead({ projects, cwd, projectId, branch, onPick, checkout, where }: Props) {
  const project = (projectId && projects.find((p) => p.id === projectId)) || projects.find((p) => p.path === cwd)
  const label = project?.name ?? homely(cwd).split('/').filter(Boolean).pop() ?? cwd

  return (
    <>
      {onPick && (choosesProject(projects) || !project) ? (
        <ProjectPicker projects={projects} cwd={cwd} onPick={onPick} />
      ) : (
        <span className="chip ink" title={`Project folder: ${cwd}`}>
          <span className="pdot" style={{ background: projectColor(project?.id ?? cwd) }} aria-hidden="true" />
          <span className="name">{label}</span>
        </span>
      )}
      {checkout ??
        (branch && (
          <span className="branch" title="Current branch">
            <GitBranch size={12} aria-hidden="true" />
            {branch}
          </span>
        ))}
      <span className="path" title={where ?? cwd}>
        {homely(where ?? cwd)}
      </span>
    </>
  )
}

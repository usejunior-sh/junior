import { GitBranch } from 'lucide-react'
import type { Project } from '../../../shared/protocol.js'
import { projectColor } from '../tabs.js'
import { choosesProject, ProjectPicker } from './ProjectPicker.js'

type Props = {
  projects: readonly Project[]
  cwd: string
  branch?: string | null
  /** Omitted once the session exists — a running session's folder is fixed. */
  onPick?: (cwd: string) => void
}

/** `/Users/you/Code/x` → `~/Code/x` — display only. */
const homely = (p: string) => p.replace(/^\/(?:Users|home)\/[^/]+/, '~')

/** Where the prompt runs: project, branch, folder. The header of the prompt box. */
export function PromptHead({ projects, cwd, branch, onPick }: Props) {
  const project = projects.find((p) => p.path === cwd)
  const label = project?.name ?? homely(cwd).split('/').filter(Boolean).pop() ?? cwd

  return (
    <>
      {onPick && (choosesProject(projects) || !project) ? (
        <ProjectPicker projects={projects} cwd={cwd} onPick={onPick} />
      ) : (
        <span className="chip ink" title={`Project folder: ${cwd}`}>
          <span className="pdot" style={{ background: projectColor(cwd) }} aria-hidden="true" />
          <span className="name">{label}</span>
        </span>
      )}
      {branch && (
        <span className="branch" title="Current branch">
          <GitBranch size={12} aria-hidden="true" />
          {branch}
        </span>
      )}
      <span className="path" title={cwd}>
        {homely(cwd)}
      </span>
    </>
  )
}

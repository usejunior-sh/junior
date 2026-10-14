import * as RadioGroup from '@radix-ui/react-radio-group'
import { Check, Folder, GitBranch, LoaderCircle, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  mentionToken,
  type BranchResponse,
  type CreateStep,
  type EffortLevel,
  type ImageAttachment,
  type Mention,
  type PermissionMode,
  type Project,
  type ProjectsResponse,
  type ProviderId,
} from '../../../shared/protocol.js'
import { branchFromTitle, plausibleBranch } from '../../../shared/branch.js'
import type { Draft } from '../drafts.js'
import { useCheckouts, useSessions } from '../hooks.js'
import { readSessionDefaults, writeSessionDefaults } from '../sessionDefaults.js'
import { PromptBox } from './PromptBox.js'
import { defaultProjectOf } from './ProjectPicker.js'
import { CheckoutPicker } from './CheckoutPicker.js'
import { PromptHead } from './PromptHead.js'

export type NewSession = {
  title: string
  cwd: string
  firstMessage: string
  model?: string
  effort?: EffortLevel
  fastMode?: boolean
  permissionMode?: PermissionMode
  /** The agent the session runs on for life; absent = Claude. */
  provider?: ProviderId
  images?: ImageAttachment[]
  mentions?: Mention[]
  /** the work item this session is dispatched for (recorded as a link) */
  itemId?: string
  /** an existing worktree to run in */
  checkoutId?: string
  /** a new worktree to make, then run in */
  worktree?: { branch: string }
}

type Props = {
  /** The draft this tab edits; text and folder round-trip through it so they survive a tab switch. */
  draft: Draft
  onChange: (patch: { text?: string; cwd?: string; label?: string; checkoutId?: string; newBranch?: string }) => void
  onCreate: (s: NewSession) => void
  /** the last send failed (e.g. the worktree couldn't be made) — a new object per failure */
  error?: { message: string } | null
  /** a send that makes a worktree: the step the server is on */
  step?: CreateStep | null
}

const STEPS: { step: CreateStep; label: (branch: string) => string }[] = [
  { step: 'worktree', label: (b) => `Creating worktree ${b}` },
  { step: 'files', label: () => 'Copying node_modules and .env' },
  { step: 'session', label: () => 'Starting the session' },
]

/** A send that makes a worktree, as a checklist: done, doing, to do — with a running clock. */
function MakingWorktree({ branch, step }: { branch: string; step: CreateStep | null }) {
  const [started] = useState(Date.now)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(t)
  }, [])
  const at = step ? STEPS.findIndex((s) => s.step === step) : 0
  return (
    <div className="makingWt" role="status" aria-live="polite">
      <ol>
        {STEPS.map((s, i) => (
          <li key={s.step} className={i < at ? 'done' : i === at ? 'now' : 'todo'}>
            {i < at ? (
              <Check size={12} aria-hidden="true" />
            ) : i === at ? (
              <LoaderCircle size={12} className="spin" aria-hidden="true" />
            ) : (
              <span className="dotTodo" aria-hidden="true" />
            )}
            {s.label(branch)}
          </li>
        ))}
      </ol>
      <span className="secs">{((now - started) / 1000).toFixed(1)}s</span>
    </div>
  )
}


/** The first line names the session; `@` tokens read as their labels, not their ids. */
function titleFrom(text: string, mentions: readonly Mention[] = []): string {
  let line = text.trim().split('\n')[0]
  for (const m of mentions) line = line.split(mentionToken(m)).join(`@${m.label}`)
  return line.slice(0, 80)
}


/** A draft tab: the composer that becomes a session on first send. */
export function NewSessionComposer({ draft, onChange, onCreate, error, step }: Props) {
  const [projects, setProjects] = useState<Project[]>([])
  const [branch, setBranch] = useState<string | null>(null)
  const checkouts = useCheckouts()
  const sessions = useSessions()
  // A send that makes a worktree takes a moment (git, then a node_modules clone); say so until it lands or fails.
  const [making, setMaking] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  useEffect(() => {
    if (error) setMaking(null)
  }, [error])
  // No folder chosen yet → the default project. Until projects load the
  // server picks it: an empty cwd on send means "the default project".
  const fallback = defaultProjectOf(projects)
  // "New job": a chat with Junior that sets one up — no checkout to pick, the job names its own project.
  const job = draft.intent === 'job'
  const cwd = draft.cwd ?? fallback?.path ?? '~'
  // The project's live checkouts; the picker shows for git projects only (main has a branch, or worktrees exist).
  const project = projects.find((p) => p.path === cwd)
  const projectCheckouts = project ? checkouts.filter((c) => c.projectId === project.id && c.state === 'active') : []
  const mainCo = projectCheckouts.find((c) => c.kind === 'main')
  const canPick = !!mainCo && (mainCo.branch !== null || projectCheckouts.length > 1)
  const pickedCo = canPick && draft.newBranch === undefined ? projectCheckouts.find((c) => c.id === draft.checkoutId && c.kind === 'worktree') : undefined
  const isNew = canPick && draft.newBranch !== undefined
  // A dispatched item asks where it runs, up front; the head's picker stays in step with it.
  const suggestBranch = () => draft.branchHint ?? branchFromTitle(draft.label ?? draft.text)
  // The item's own worktree, read live rather than trusted from the draft — a draft can outlive the moment it was made.
  const continueCo = projectCheckouts.find(
    (c) => c.kind === 'worktree' && (c.id === draft.continueIn || (!!draft.itemId && c.itemId === draft.itemId)),
  )
  // Git gives a branch one folder: a "new" branch that already has a worktree just runs there.
  const typedBranch = isNew ? (draft.newBranch ?? '').trim() : ''
  const sameBranchCo = typedBranch ? projectCheckouts.find((c) => c.kind === 'worktree' && c.branch === typedBranch) : undefined
  const where = isNew ? 'new' : pickedCo ? (pickedCo.id === continueCo?.id ? 'continue' : '') : 'main'
  const pickWhere = (v: string) => {
    setLocalError(null)
    if (v === 'main') onChange({ checkoutId: undefined, newBranch: undefined })
    else if (v === 'continue' && continueCo) onChange({ checkoutId: continueCo.id, newBranch: undefined })
    else if (v === 'new') onChange({ checkoutId: undefined, newBranch: draft.newBranch ?? suggestBranch() })
  }
  // The last pick here is the default for the next new session — a per-browser
  // preference (see sessionDefaults.ts), which the Sessions settings tab edits too.
  // Read on mount, not at module load: the page lives for days in the Mac app,
  // so a load-time read would pin every new draft to the first pick.
  const [defaults] = useState(readSessionDefaults)
  const [model, setModel] = useState<string | undefined>(defaults.model)
  const [effort, setEffort] = useState<EffortLevel | undefined>(defaults.effort)
  const [fastMode, setFastMode] = useState(defaults.fastMode)
  const [permissionMode, setPermissionMode] = useState<PermissionMode | undefined>(defaults.permissionMode)
  // Every draft starts on Claude. The saved defaults are Claude's (its model
  // ids, its fast mode), so they are neither carried into another agent nor
  // overwritten by a pick made there.
  const [provider, setProvider] = useState<ProviderId>('claude')
  const onClaude = provider === 'claude'

  useEffect(() => {
    void fetch('/api/projects')
      .then((r) => r.json() as Promise<ProjectsResponse>)
      .then((b) => {
        if (b.ok) setProjects(b.projects)
      })
      .catch(() => {})
  }, [])

  // The header names the branch the session will start on.
  useEffect(() => {
    let live = true
    setBranch(null)
    void fetch(`/api/git/branch?cwd=${encodeURIComponent(cwd)}`)
      .then((r) => r.json() as Promise<BranchResponse>)
      .then((b) => {
        if (live && b.ok) setBranch(b.branch)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [cwd])

  return (
    <div id="newSessionHome">
      <div className="glow blue" aria-hidden="true" />
      <h2>{job ? 'Tell Junior about the job.' : draft.label ? 'Dispatching.' : 'What are we working on?'}</h2>
      {draft.itemId && canPick && mainCo && (
        <div className="runIn">
          <span className="lbl" id={`runin-${draft.id}`}>
            Run in
          </span>
          <RadioGroup.Root className="seg" aria-labelledby={`runin-${draft.id}`} value={where} onValueChange={pickWhere}>
            <RadioGroup.Item value="main" className={`segBtn${where === 'main' ? ' active' : ''}`} title={mainCo.path}>
              <Folder size={11} aria-hidden="true" /> Current folder{mainCo.branch ? ` · ${mainCo.branch}` : ''}
            </RadioGroup.Item>
            {continueCo && (
              <RadioGroup.Item value="continue" className={`segBtn wt${where === 'continue' ? ' active' : ''}`} title={continueCo.path}>
                <GitBranch size={11} aria-hidden="true" /> Continue in {continueCo.branch ?? 'its worktree'}
              </RadioGroup.Item>
            )}
            <RadioGroup.Item value="new" className={`segBtn wt${where === 'new' ? ' active' : ''}`} title="A new branch and folder for this item">
              <Plus size={11} aria-hidden="true" /> New worktree
            </RadioGroup.Item>
          </RadioGroup.Root>
        </div>
      )}
      <PromptBox
        draftKey={draft.id}
        head={
          <PromptHead
            projects={projects}
            cwd={cwd}
            branch={branch}
            // A worktree belongs to one project: changing project drops it, keeps a new branch's name.
            onPick={(path) => onChange({ cwd: path, checkoutId: undefined })}
            checkout={
              canPick && project && !job ? (
                <CheckoutPicker
                  projectName={project.name}
                  checkouts={projectCheckouts}
                  checkoutId={draft.checkoutId}
                  newBranch={draft.newBranch}
                  onPick={(pick) => {
                    setLocalError(null)
                    onChange({ checkoutId: pick.checkoutId, newBranch: pick.newBranch })
                  }}
                  suggest={suggestBranch}
                  sessionsIn={(id) => sessions.filter((x) => x.checkoutId === id).length}
                />
              ) : undefined
            }
            where={sameBranchCo ? sameBranchCo.path : isNew ? 'a new worktree, made when you send' : pickedCo?.path}
          />
        }
        cwd={cwd}
        text={draft.text}
        onTextChange={(text) => onChange({ text })}
        placeholder={
          job
            ? 'What should it do, how often, and what must it never do? e.g. “Every weekday at 9, find PRs waiting on my review”'
            : 'Describe what you want to work on — a bug, a feature, a question…'
        }
        focusKey={draft.id}
        sendTitle="Start the session (Enter)"
        busy={!!making}
        initialMentions={draft.mentions}
        onSubmit={(text, images, mentions) => {
          const newBranch = isNew ? (draft.newBranch?.trim() || branchFromTitle(text)) : ''
          const existing = isNew ? projectCheckouts.find((c) => c.kind === 'worktree' && c.branch === newBranch) : undefined
          if (isNew && !existing && !plausibleBranch(newBranch)) {
            setLocalError(newBranch ? `"${newBranch}" isn't a branch name git will take` : 'Name the branch for the new worktree')
            return
          }
          setLocalError(null)
          if (isNew && !existing) setMaking(newBranch)
          onCreate({
            title: job ? `New job: ${titleFrom(text, mentions)}` : (draft.label ?? titleFrom(text, mentions)),
            cwd: draft.cwd ?? fallback?.path ?? '',
            firstMessage: job ? `New job: ${text}` : text,
            model,
            effort,
            fastMode: onClaude && fastMode,
            permissionMode,
            ...(onClaude ? {} : { provider }),
            images,
            mentions,
            ...(draft.itemId ? { itemId: draft.itemId } : {}),
            ...(existing
              ? { checkoutId: existing.id }
              : isNew
                ? { worktree: { branch: newBranch } }
                : pickedCo
                  ? { checkoutId: pickedCo.id }
                  : {}),
          })
        }}
        model={model}
        effort={effort}
        fastMode={fastMode}
        permissionMode={permissionMode}
        onModelChange={(m, e) => {
          setModel(m)
          setEffort(e)
          if (onClaude) writeSessionDefaults({ model: m, effort: e })
        }}
        provider={provider}
        onProviderChange={(p) => {
          // Back on Claude: its saved defaults, re-read. Elsewhere: that agent's default model.
          const d = p === 'claude' ? readSessionDefaults() : undefined
          setProvider(p)
          setModel(d?.model)
          setEffort(d?.effort)
        }}
        onFastModeChange={(on) => {
          setFastMode(on)
          writeSessionDefaults({ fastMode: on })
        }}
        onPermissionModeChange={(m) => {
          setPermissionMode(m)
          writeSessionDefaults({ permissionMode: m })
        }}
      />
      {(localError || (error && !making)) && (
        <p className="composeError" role="alert">
          {localError ?? error?.message}
        </p>
      )}
      {sameBranchCo && !making && (
        <p className="composeNote">
          {typedBranch} already has a worktree — this session runs there.{' '}
          {continueCo?.id === sameBranchCo.id ? 'It was made for this item.' : ''}
        </p>
      )}
      {making && <MakingWorktree branch={making} step={step ?? null} />}
      <div className="keysHint">
        <kbd>Enter</kbd> starts · <kbd>Shift+Enter</kbd> newline · <kbd>Shift+Tab</kbd> changes what gets asked
      </div>

    </div>
  )
}

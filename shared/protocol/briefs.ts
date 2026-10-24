import type { Artifact } from './artifacts.js'
import type { Mention } from './mentions.js'

// Briefs, a playbook run against one work
// item that writes a markdown brief (an artifact linked with role `brief`).
// The job row IS the queue: FIFO per workspace, one at a time, daily cap.
// `stale` is not stored: it is derived when the source moved after the brief.

export type BriefStatus = 'queued' | 'running' | 'ready' | 'failed'
export const BRIEF_STATUSES: readonly BriefStatus[] = ['queued', 'running', 'ready', 'failed']

export type BriefJob = {
  id: string
  itemId: string
  status: BriefStatus
  /** the playbook used: an ItemKind name, resolved to a file under the workspace's playbooks/ */
  playbook: string
  /** the template text as edited in the brief composer for this brief only; null = the file as it was */
  playbookBody: string | null
  model: string | null
  /** the user's context note from the brief composer */
  note: string | null
  /** the brief session (kind 'brief'); null while queued */
  sessionId: string | null
  /** the artifact the run wrote; null until the first successful write */
  artifactId: string | null
  error: string | null
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
}

/** GET /api/briefs?itemId=: the item's latest job with what it produced. */
export type BriefView = {
  job: BriefJob | null
  /** the source moved after the brief was written, offer a re-brief */
  stale: boolean
  artifact: Artifact | null
  body: string | null
  /** 0-based place in the queue while queued, else null */
  queuePosition: number | null
}

export type BriefResponse = { ok: true; brief: BriefView } | { ok: false; error: string }
export type BriefJobsResponse = { ok: true; jobs: BriefJob[] } | { ok: false; error: string }

/** POST /api/briefs body. */
export type BriefRequest = {
  itemIds: string[]
  note?: string
  model?: string
  /** override the playbook (an ItemKind name or a brief type); default = the item's kind */
  playbook?: string
  /** the playbook's text as edited for this brief; sent only when it differs from the file */
  playbookBody?: string
}

// Playbooks (GET/PUT /api/playbooks?kind=): one markdown file per ItemKind,
// seeded with defaults, edited like a skill.
export type PlaybookInfo = { kind: string; custom: boolean; path: string }
export type PlaybooksResponse = { ok: true; playbooks: PlaybookInfo[] } | { ok: false; error: string }
export type PlaybookResponse = { ok: true; kind: string; body: string; custom: boolean; path: string } | { ok: false; error: string }

// Workspace settings (GET/PUT /api/settings): the few server-side knobs.
export type WorkspaceSettings = {
  /** the global jobs switch; off = the scheduler never runs a job */
  jobsEnabled: boolean
  /** the babysit watch: off = it stops polling your PRs and starts no fixes */
  babysitEnabled: boolean
  /** the first-pass review watch: off = it stops polling review requests and starts no reviews */
  reviewsEnabled: boolean
  /** default per-run limits for jobs that don't set their own */
  jobTimeoutMs: number
  /** null = no cap */
  jobBudgetUsd: number | null
  /** how many brief runs may start per local day */
  briefsDailyCap: number
  /** the model briefs run on when the modal doesn't pick one; null = Claude Code's default */
  briefsDefaultModel: string | null
  /** model ids the pickers hide; the catalog stays whole, so a new model shows up on its own */
  hiddenModels: string[]
  /** model ids typed by hand, for a model the probed catalog does not list (yet) */
  customModels: string[]
  /** the browser profile this workspace's sessions use unless one picks another (.docs/browser.md) */
  browserProfile: string
}
export type SettingsResponse = { ok: true; settings: WorkspaceSettings } | { ok: false; error: string }

// Dispatch preview (GET /api/dispatch/preview?itemId=): what a dispatched
// session starts with, composed server-side so the brief rides as a mention.
export type DispatchPreview = {
  title: string
  cwd: string | null
  text: string
  mentions: Mention[]
  /** a branch for a new worktree, named from the item; null when the project isn't a git repo */
  branch: string | null
  /** a live worktree already made for this item, dispatch continues there */
  checkoutId: string | null
}
export type DispatchPreviewResponse = { ok: true; preview: DispatchPreview } | { ok: false; error: string }

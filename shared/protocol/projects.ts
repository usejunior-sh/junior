

// Connected repos (GET /api/repos, PUT /api/repos)
//
// The repos the GitHub source is scoped to, per workspace. Empty = NO GitHub
// items (.docs/workspaces.md): scope is opt-in per workspace so the same PRs
// don't mirror into every inbox. Pick the repos each workspace should track.

export type ReposResponse =
  | { ok: true; connected: string[]; available: string[] }
  | { ok: false; error: string }

// Projects (GET/POST/DELETE /api/projects)
//
// A project names a local working folder, optionally tied to a GitHub repo.
// Selecting one runs sessions in that folder; dispatch matches a work item's
// repo to a project to land in the right folder automatically.

export type Project = {
  id: string
  name: string
  /** owner/name; empty when the project isn't tied to a repo */
  repo: string
  /** absolute local folder sessions run in */
  path: string
  /** the workspace's default project: exactly one once the workspace has any */
  isDefault?: boolean
}

// Checkouts: a folder of a project. `main` is the folder
// the user added: its branch is whatever is checked out right now; a
// `worktree` is a `git worktree` of the same repo, found with `git worktree
// list`. Sessions and terminals belong to one; the inbox stays workspace-wide.

export type CheckoutKind = 'main' | 'worktree'
/** `removed` = the folder is gone; the row stays so its sessions keep their history. */
export type CheckoutState = 'active' | 'removed'

export type Checkout = {
  id: string
  projectId: string
  kind: CheckoutKind
  /** absolute folder */
  path: string
  /** the checked-out branch as last read from git; null = detached HEAD or not a repo */
  branch: string | null
  /** the branch a worktree was cut from; null for main, and for worktrees made outside triage */
  base: string | null
  /** the work item a worktree was made for, when triage made it for one */
  itemId: string | null
  state: CheckoutState
  createdAt: number
}

/** An editor triage found on this machine, for "Open in…" (GET /api/editors). */
export type Editor = { id: string; name: string }

export type EditorsResponse = { ok: true; editors: Editor[] } | { ok: false; error: string }

/**
 * POST /api/checkouts/:id/open with `{ editor }`: an editor id from
 * /api/editors, or 'finder' to reveal the folder.
 */
export type OpenCheckoutResponse = { ok: true } | { ok: false; error: string }
// POST /api/checkouts/:id/recreate: a removed worktree back at its same folder
// (so its sessions resume), node_modules and .env copied in again. Answers as OpenCheckoutResponse.

/**
 * GET /api/checkouts/:id/removal: what removing a worktree would lose, read
 * before asking. `safe` = nothing: merged, clean, nothing running in it.
 */
export type RemovalCheck = {
  branch: string | null
  /** the branch its commits are compared with (the repo's default branch) */
  base: string | null
  /** commits on the worktree's branch that `base` doesn't have; null when it can't be told */
  unmerged: number | null
  /** uncommitted files in the folder */
  uncommitted: number
  /** sessions working there right now: removing stops them */
  running: number
  safe: boolean
}

/** Where a session being made in a new worktree has got to: the git worktree, its node_modules and .env, the session itself. */
export type CreateStep = 'worktree' | 'files' | 'session'

export type RemovalCheckResponse = { ok: true; check: RemovalCheck } | { ok: false; error: string }

/**
 * POST /api/checkouts/:id/remove with `{ force?, deleteBranch? }`,
 * `git worktree remove`, then the local branch. Without `force` an unsafe
 * worktree is refused and the check comes back to say why.
 */
export type RemoveCheckoutResponse = { ok: true } | { ok: false; error: string; check?: RemovalCheck }

export type ProjectsResponse =
  | { ok: true; projects: Project[] }
  | { ok: false; error: string }

// GET /api/git/branch?cwd=…: the checked-out branch of a folder, for the
// draft composer's header (a session derives its own once it exists).
export type BranchResponse = { ok: true; branch: string | null } | { ok: false; error: string }

// Session changes: what a session's own turns did to the repo it runs in

/** git's own letters, plus untracked-at-snapshot files, which read as added. */
export type ChangeStatus = 'modified' | 'added' | 'deleted'

/**
 * How sure we are that *this* session made a change. Sessions share a working
 * tree, so this is inferred, not definitional (worktree-per-session would make
 * it definitional):
 *  - `exact`, it moved inside one of this session's turn windows and no
 *                  other session's turn was running in the same repo then.
 *  - `shared`, another session's turns changed this file too.
 *  - `ambiguous`, it moved during a turn that overlapped another session's,
 *                  and none of our own tools named it.
 */
export type ChangeConfidence = 'exact' | 'shared' | 'ambiguous'

export type ChangedFile = {
  /** repo-relative, `/`-joined */
  path: string
  status: ChangeStatus
  insertions: number
  deletions: number
  isBinary: boolean
  /** an Edit/Write/MultiEdit/NotebookEdit of this session named the path */
  touched: boolean
  confidence: ChangeConfidence
  /** titles of other sessions whose own turns also changed this file */
  alsoChangedBy: string[]
  /** which of this session's turns (1-based) changed it */
  turns: number[]
}

/** One turn of this session, as the changes view counts it. */
export type SessionTurnSummary = {
  seq: number
  files: number
  insertions: number
  deletions: number
  startedAt: number
  /** null while the turn is still running */
  endedAt: number | null
  /** titles of other sessions whose turns overlapped this one in this repo */
  overlapped: string[]
}

export type SessionChanges = {
  /** the repo root; null when the session's folder is not in a git repo */
  root: string | null
  /** set when there is nothing to show and the reason is worth saying */
  unavailable?: string
  files: ChangedFile[]
  turns: SessionTurnSummary[]
  insertions: number
  deletions: number
}

export type SessionChangesResponse =
  | { ok: true; changes: SessionChanges }
  | { ok: false; error: string }

/** GET /api/sessions/:id/diff?path=…: one file, as unified-diff text. */
export type SessionDiffResponse =
  | { ok: true; path: string; patch: string; isBinary: boolean; truncated: boolean }
  | { ok: false; error: string }

// Working changes (the Changes rail): every project's uncommitted files
// against HEAD, whoever made them. Paths are relative to the project folder.

export type WorkingFile = {
  path: string
  status: ChangeStatus
  insertions: number
  deletions: number
  isBinary: boolean
}

/** One checkout's uncommitted work against its own HEAD. */
export type CheckoutChanges = {
  checkout: Checkout
  files: WorkingFile[]
  insertions: number
  deletions: number
  /** worktrees only: commits on its branch that the main checkout's branch doesn't have */
  ahead?: number
  /** git failed for this checkout; the others still load */
  error?: string
}

export type ProjectChanges = {
  project: Project
  /** false when the project folder is not inside a git repo */
  isRepo: boolean
  /** main first, then worktrees by branch; removed ones are left out */
  checkouts: CheckoutChanges[]
}

/** GET /api/changes */
export type WorkingChangesResponse =
  | { ok: true; projects: ProjectChanges[] }
  | { ok: false; error: string }

/**
 * GET /api/changes/diff?checkoutId=…&path=…: the same shape as a session's
 * file diff. A project id in `checkoutId` (or the older `projectId=`) means
 * that project's main checkout, so links made before checkouts still open.
 */
export type WorkingDiffResponse = SessionDiffResponse

/**
 * GET /api/changes/file?checkoutId=…&path=…: a changed file, for editing.
 * `version` is a hash of the bytes read; a save sends it back so an edit made
 * on disk in the meantime (an agent, your editor) is refused, not clobbered.
 */
export type ProjectFileResponse =
  | { ok: true; path: string; kind: 'text'; content: string; version: string }
  | { ok: true; path: string; kind: 'binary' | 'large' | 'missing'; bytes: number }
  | { ok: false; error: string }

/** PUT /api/changes/file?checkoutId=…&path=… with body `{ content, version }`. */
export type SaveProjectFileResponse =
  | { ok: true; version: string }
  | { ok: false; error: string; conflict?: boolean }

// POST /api/pick-folder: opens the OS's native folder chooser on the machine
// running the server (which is the user's own machine) and returns the picked
// absolute path. `cancelled` is the user dismissing the dialog, not an error.
export type PickFolderResponse =
  | { ok: true; path: string }
  | { ok: true; cancelled: true }
  | { ok: false; error: string }

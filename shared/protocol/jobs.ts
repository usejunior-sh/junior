

// Jobs (GET/POST/PUT/DELETE /api/jobs, POST /api/jobs/draft,
// POST /api/jobs/preview): the ingestion engine (.docs/jobs.md).
// Domain types live in core/job/types.ts; type-only re-exports, so nothing
// server-side leaks into the browser bundle.

export type { NewJob, Job, JobCadence, JobConnector, JobDraft, JobNotify, JobOutput, JobPreviewResult, JobPreviewRow, JobRunStatus, JobRunTrigger, JobSlotRun, JobSlotStatus, JobToolGrant } from '../../core/job/types.js'

export type JobsResponse =
  | { ok: true; jobs: import('../../core/job/types.js').Job[] }
  | { ok: false; error: string }

/** The job file editor's side list: what a file may name on this machine. */
export type JobFileReference = {
  projects: { id: string; name: string }[]
  builtins: string[]
  /** each connected MCP server and its tool lines, as a file spells them (`<server>/<tool>`) */
  servers: { server: string; tools: string[] }[]
  /** skills and agents a job may name (`skills:`, `agents:`), not a project's, which runs don't load */
  skills: string[]
  agents: string[]
}

/**
 * GET /api/jobs/file[?id=]: a job's file text (or a starter) and the
 * reference list. POST /api/jobs/file[?id=] { text }: saved only when it
 * validates; otherwise `errors` lists every problem and nothing is written.
 */
export type JobFileResponse =
  | { ok: true; text: string; file?: string; reference: JobFileReference }
  | { ok: true; id: string }
  | { ok: false; error: string; errors?: string[] }

/**
 * GET /api/jobs/recipe?id=: the job as a recipe (core/job/recipe.ts
 * `toRecipe`): no id, no project, off, paths, ids and secrets taken out.
 * `errors` non-empty = it won't import cleanly, so the page copies nothing.
 */
export type JobRecipeResponse =
  | { ok: true; text: string; errors: string[]; scrubbed: { paths: number; ids: number; secrets: number } }
  | { ok: false; error: string }

/** GET /api/jobs/runs?id=: the slot ledger for one job, newest slot first. */
export type JobRunsResponse =
  | { ok: true; runs: import('../../core/job/types.js').JobSlotRun[] }
  | { ok: false; error: string }

export type JobDraftResponse =
  | { ok: true; draft: import('../../core/job/types.js').JobDraft }
  | { ok: false; error: string }

// A preview is a dry run streamed like a session: POST starts it and returns
// an ephemeral session id to subscribe to; GET polls its outcome. Nothing is
// stored: the events live in memory for a few minutes and then go.
export type JobPreviewStartResponse = { ok: true; previewId: string } | { ok: false; error: string }
export type JobPreviewStatusResponse =
  | { ok: true; status: 'running' | 'ready' | 'failed'; result?: import('../../core/job/types.js').JobPreviewResult; error?: string }
  | { ok: false; error: string }

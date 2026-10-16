/**
 * The triage MCP contract — one tool table, one dispatcher, two external
 * transports.
 *
 * The stdio shim (server/mcp.ts, dependency-free, for clients that spawn a
 * process) and the daemon's own streamable-HTTP endpoint (POST /mcp in
 * server/index.ts, for clients that take a URL) both import this file, so
 * they cannot drift — a tool that exists over stdio and not over HTTP is the
 * kind of gap nobody notices until an agent silently stops being able to file
 * work. The in-process SDK server that web chats get is defined separately
 * with zod in server/index.ts, against the same `*Op` functions.
 *
 * Everything routes through the daemon's HTTP API via the injected `api`, so
 * the SQLite single-writer stays the server process whichever door was used.
 */

import { GOAL_TOOLS } from '../goals/tools.js'
import { LEAD_LOG_ENTRIES } from '../goals/types.js'

/** How a transport reaches the triage API. Returns the parsed JSON body. */
export type McpApi = (path: string, body?: unknown, method?: string) => Promise<unknown>

/** What this connection is, for get_workspace to report back honestly. */
export type Connection = { serverUrl: string; requestedWorkspace: string | null }

export type ToolResult = { text: string; isError: boolean }

/** draft_job's skills/agents arguments, said once for every transport. */
export const SKILLS_ARG =
  'skills the runs may load, as Claude calls them: triage:<name> for the workspace library, <name> for personal ones, <plugin>:<name>. Only these load; omit for none'
export const AGENTS_ARG = 'subagents the runs may hand work to, named the same way. Only these start; omit for none'

/** The MCP revision both transports speak. */
export const PROTOCOL_VERSION = '2024-11-05'

export const TOOLS = [
  {
    name: 'list_work_items',
    description:
      'Read the ranked triage queue: work items with their deterministic score, group, and reason. Open items by default — pass status to read the done, snoozed or archived lists instead. Optional filters narrow by source or kind.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'snoozed', 'done', 'archived'],
          description: 'which list to read (default "open")',
        },
        source: { type: 'string', enum: ['github', 'slack', 'linear'], description: 'only items from this source' },
        kind: { type: 'string', description: 'only items of this kind, e.g. "job-hit"' },
      },
    },
  },
  {
    name: 'get_work_item',
    description:
      'Everything about one work item by id, at any status: the item, its rank if it is in the open inbox, the items sharing a ref with it, the artifacts linked to it (its brief and any context notes) and the sessions that worked it. Use this to follow an id from list_work_items or from a linked sibling.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'e.g. "github:owner/repo#12" or "manual:<uuid>"' } },
      required: ['id'],
    },
  },
  {
    name: 'get_session_context',
    description:
      "What a triage session is: its workspace, the work item it was opened for (with that item's brief and notes), and the artifacts attached to it. The ids it returns are what write_artifact's `links` needs.",
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'a triage session id' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'get_workspace',
    description:
      'Which triage workspace this connection is acting in: `current` (id, name, whether it is the default, auth backend) plus `workspaces`, the roster of ids to switch among. This connection picks its workspace with the TRIAGE_WORKSPACE env var; an id that matches no workspace is refused by every other tool, and this one reports the id you requested and whether it matched. Everything you list/create/edit here lives in `current`.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'upsert_work_item',
    description:
      'Idempotently upsert one work item into the triage inbox. Id-keyed (e.g. "slack:<permalink-tail>", "github:owner/repo#123"), update-only-if-newer (by updatedAt), user-state-preserving: calling this repeatedly can never create duplicates or clobber done/snoozed/dismissed state. Invalid items are rejected, never repaired.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'stable id: "slack:...", "github:owner/repo#123", or "linear:KEY-123"' },
        kind: { type: 'string', description: 'item kind, e.g. "job-hit", "mention", "fyi"' },
        title: { type: 'string' },
        url: { type: 'string' },
        repo: { type: 'string', description: 'the item\'s home: repo, Slack channel, or Linear team' },
        author: { type: 'string' },
        peopleWaiting: { type: 'number' },
        createdAt: { type: 'string', description: 'ISO 8601' },
        updatedAt: { type: 'string', description: 'ISO 8601 — the upsert applies only if newer than what is stored' },
        jobId: { type: 'string', description: 'the job that produced it, if any' },
        why: { type: 'string', description: 'one-line match reason, rendered on the item' },
        ask: {
          type: 'string',
          enum: ['review', 'reply', 'decide', 'do', 'follow-up', 'read'],
          description: 'what it asks of the user (job hits); decides its label',
        },
        due: { type: 'string', description: 'a deadline the source states, ISO 8601 day (e.g. 2026-10-12)' },
        refs: { type: 'array', items: { type: 'string' }, description: 'PR/issue URLs or Linear keys seen in the content' },
      },
      required: ['id', 'kind', 'title', 'url', 'updatedAt'],
    },
  },
  {
    name: 'create_work_item',
    description:
      'Add a manual to-do to the inbox (a user-authored item). Title is required; note, url, urls, priority (1–4), due (ISO day), and projectId are optional.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'what the to-do is' },
        note: { type: 'string' },
        url: { type: 'string', description: 'an http(s) link' },
        urls: { type: 'array', items: { type: 'string' }, description: 'more http(s) links — the Slack thread, the PR, a doc' },
        priority: { type: 'number', description: '1 urgent … 4 low' },
        projectId: { type: 'string', description: 'an existing project id' },
        due: { type: 'string', description: 'due day, ISO 8601 (e.g. 2026-10-21)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'draft_job',
    description:
      'Draft a job — a scheduled headless run that files matches as work items (or writes a digest). It is saved OFF as a draft: only the user can enable it, from the job page this returns a link to. Use when the user asks to run something on a schedule, monitor it or keep an eye on it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'a short name, e.g. "Anirudha’s PRs"' },
        schedule: { type: 'string', description: 'a 5-field cron line in local time: "0 * * * *" hourly, "0 9 * * 1-5" weekdays at 9' },
        instruction: { type: 'string', description: 'where to look, what counts as a match, what to file — written for the run, which sees only this' },
        project: { type: 'string', description: 'the project folder runs work in: an id or a name; default = the default project' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'what runs may use, one per entry: built-ins web, github, files-write, or "<server>/<tool>" for an MCP tool; default [web]',
        },
        output: { type: 'string', enum: ['items', 'digest'], description: 'items (one work item per match, default) or digest' },
        model: { type: 'string', description: 'model for the runs; default = Claude Code’s' },
        brief: { type: 'boolean', description: 'brief every item it files (items output only)' },
        brief_model: { type: 'string', description: 'model for the briefs' },
        brief_template: { type: 'string', description: 'playbook to brief with, e.g. "review-requested"; default = the item’s kind' },
        skills: { type: 'array', items: { type: 'string' }, description: SKILLS_ARG },
        agents: { type: 'array', items: { type: 'string' }, description: AGENTS_ARG },
      },
      required: ['title', 'schedule', 'instruction'],
    },
  },
  {
    name: 'edit_work_item',
    description:
      'Edit a manual to-do by id (id must start with "manual:"). Only the fields you pass change; priority 0/null and due null clear them.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'the manual item id, e.g. "manual:<uuid>"' },
        title: { type: 'string' },
        note: { type: 'string' },
        url: { type: 'string' },
        urls: { type: 'array', items: { type: 'string' }, description: 'the complete list of extra links; [] clears them' },
        priority: { type: 'number', description: '1–4, or 0/null to clear' },
        projectId: { type: 'string' },
        due: { type: ['string', 'null'], description: 'due day, ISO 8601 (e.g. 2026-10-21), or null to clear' },
      },
      required: ['id'],
    },
  },
  {
    name: 'resolve_work_item',
    description:
      'Mark one work item done (by id). Subject to the re-arm rule like any done: if the source updates afterwards, the item returns to the inbox.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
  },
  // Artifacts — markdown notes/briefs beside the inbox (.docs/next-version.md).
  {
    name: 'list_artifacts',
    description:
      "List the workspace's artifacts — markdown notes and briefs kept beside the work items — with id, title, author (human|model), refs, path and links.",
    inputSchema: {
      type: 'object',
      properties: { all: { type: 'boolean', description: 'include briefs of finished items (hidden by default)' } },
    },
  },
  {
    name: 'read_artifact',
    description: 'Read one artifact by id: title, author, refs, path on disk and the full markdown body.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'write_artifact',
    description:
      'Create a new model-authored artifact (markdown note), optionally linked to a work item or session as context. Returns its id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string', description: 'markdown' },
        refs: { type: 'array', items: { type: 'string' }, description: 'PR/issue URLs or Linear keys it is about' },
        links: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['item', 'session'] },
              id: { type: 'string' },
              role: { type: 'string', enum: ['brief', 'context', 'dispatch'] },
            },
            required: ['kind', 'id', 'role'],
          },
        },
      },
      required: ['title', 'body'],
    },
  },
  {
    name: 'update_artifact',
    description:
      'Rewrite a model-authored artifact in place (title, body, refs). Human-authored artifacts are refused — propose the change to the user instead.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        refs: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'link_artifact',
    description: 'Link an existing artifact to a work item or session with a role (usually "context").',
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        kind: { type: 'string', enum: ['item', 'session'] },
        id: { type: 'string' },
        role: { type: 'string', enum: ['brief', 'context', 'dispatch'] },
      },
      required: ['artifactId', 'kind', 'id', 'role'],
    },
  },
  // Goals (core/goals/tools.ts): goal_create, goal_get, goal_list, goal_propose_plan, goal_log_append, goal_handoff_write.
  ...GOAL_TOOLS,
]

/** A goal write's reply, as one line an agent can act on. */
function goalWrite(body: { ok: boolean; goal?: { id: string; state: string }; outcome?: string; error?: string }): ToolResult {
  return body.ok && body.goal
    ? { text: `ok: ${body.outcome} · goal ${body.goal.id} · ${body.goal.state}`, isError: false }
    : { text: `rejected: ${body.error}`, isError: true }
}

export async function callTool(
  api: McpApi,
  conn: Connection,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (name === 'list_work_items') {
    // 'open' is the live inbox (a scan); every other status is a plain read of
    // the durable store — the same split the server makes internally. The
    // status is checked here rather than left to /api/items, which falls back
    // to 'open' for anything it does not recognise: a caller that asked for
    // 'archived' must not be handed the open queue and told nothing.
    const status = typeof args.status === 'string' ? args.status : 'open'
    if (!['open', 'snoozed', 'done', 'archived'].includes(status))
      return { text: `rejected: unknown status "${status}"`, isError: true }
    const path = status === 'open' ? '/api/inbox' : `/api/items?status=${encodeURIComponent(status)}`
    const body = (await api(path)) as { ok: boolean; items?: { source: string; kind: string }[]; error?: string }
    if (!body.ok) return { text: `inbox read failed: ${body.error}`, isError: true }
    let items = body.items ?? []
    if (typeof args.source === 'string') items = items.filter((i) => i.source === args.source)
    if (typeof args.kind === 'string') items = items.filter((i) => i.kind === args.kind)
    return { text: JSON.stringify(items, null, 2), isError: false }
  }
  if (name === 'get_work_item') {
    if (typeof args.id !== 'string' || !args.id) return { text: 'rejected: need a work-item id', isError: true }
    const body = (await api(`/api/items/detail?id=${encodeURIComponent(args.id)}`)) as {
      ok: boolean
      detail?: unknown
      error?: string
    }
    return body.ok
      ? { text: JSON.stringify(body.detail, null, 2), isError: false }
      : { text: `failed: ${body.error}`, isError: true }
  }
  if (name === 'get_session_context') {
    if (typeof args.sessionId !== 'string' || !args.sessionId) return { text: 'rejected: need a session id', isError: true }
    const body = (await api(`/api/sessions/context?id=${encodeURIComponent(args.sessionId)}`)) as {
      ok: boolean
      context?: unknown
      error?: string
    }
    return body.ok
      ? { text: JSON.stringify(body.context, null, 2), isError: false }
      : { text: `failed: ${body.error}`, isError: true }
  }
  if (name === 'get_workspace') {
    const body = (await api('/api/workspace')) as {
      ok: boolean
      current?: { id: string; name: string; isDefault: boolean; authBackend: string }
      workspaces?: { id: string; name: string; isDefault: boolean }[]
      error?: string
    }
    if (!body.ok || !body.current) return { text: `failed: ${body.error ?? 'no workspace'}`, isError: true }
    // The server resolved to `current`; if this connection asked for a
    // workspace that does not match, it fell back to the default — say so
    // here even though every other tool refuses outright, because this is
    // the tool a caller reaches for to find out what went wrong.
    const requested = conn.requestedWorkspace
    const matchedRequest = requested === null ? null : requested === body.current.id
    const out = {
      current: body.current,
      workspaces: body.workspaces ?? [],
      connection: { serverUrl: conn.serverUrl, requestedWorkspace: requested, matchedRequest },
    }
    const warn =
      matchedRequest === false
        ? `NOTE: this connection asked for workspace "${requested}", which matches none; the server resolved "${body.current.id}". Every other tool refuses until that is fixed.\n\n`
        : ''
    return { text: warn + JSON.stringify(out, null, 2), isError: false }
  }
  if (name === 'upsert_work_item') {
    const body = (await api('/api/items/upsert', args)) as { ok: boolean; outcome?: string; error?: string }
    return body.ok
      ? { text: `ok: ${body.outcome}`, isError: false }
      : { text: `rejected: ${body.error}`, isError: true }
  }
  if (name === 'create_work_item') {
    const body = (await api('/api/items/manual', args)) as { ok: boolean; error?: string }
    return body.ok ? { text: 'ok: created', isError: false } : { text: `rejected: ${body.error}`, isError: true }
  }
  if (name === 'draft_job') {
    const body = (await api('/api/jobs/drafted', args)) as { ok: boolean; text?: string; error?: string }
    return body.ok ? { text: body.text ?? 'ok: drafted', isError: false } : { text: `not drafted: ${body.error}`, isError: true }
  }
  if (name === 'edit_work_item') {
    const { id, ...patch } = args
    if (typeof id !== 'string' || !id) return { text: 'rejected: need a manual item id', isError: true }
    const body = (await api(`/api/items/manual?id=${encodeURIComponent(id)}`, patch, 'PUT')) as {
      ok: boolean
      error?: string
    }
    return body.ok ? { text: 'ok: edited', isError: false } : { text: `rejected: ${body.error}`, isError: true }
  }
  if (name === 'resolve_work_item') {
    const body = (await api('/api/items/resolve', { id: args.id })) as { ok: boolean; error?: string }
    return body.ok ? { text: 'ok: done', isError: false } : { text: `rejected: ${body.error}`, isError: true }
  }
  if (name === 'list_artifacts') {
    const body = (await api(`/api/artifacts${args.all === true ? '?all=1' : ''}`)) as {
      ok: boolean
      artifacts?: unknown[]
      error?: string
    }
    return body.ok
      ? { text: JSON.stringify(body.artifacts ?? [], null, 2), isError: false }
      : { text: `failed: ${body.error}`, isError: true }
  }
  if (name === 'read_artifact') {
    if (typeof args.id !== 'string' || !args.id) return { text: 'rejected: need an artifact id', isError: true }
    const body = (await api(`/api/artifacts/content?id=${encodeURIComponent(args.id)}`)) as {
      ok: boolean
      artifact?: { title: string; id: string; author: string; refs: string[] }
      body?: string
      abs?: string
      error?: string
    }
    if (!body.ok || !body.artifact) return { text: `failed: ${body.error ?? 'no such artifact'}`, isError: true }
    const a = body.artifact
    const head = [`title: ${a.title}`, `id: ${a.id}`, `author: ${a.author}`, `path: ${body.abs ?? ''}`]
    if (a.refs.length) head.push(`refs: ${a.refs.join(', ')}`)
    return { text: `${head.join('\n')}\n\n${body.body ?? ''}`, isError: false }
  }
  if (name === 'write_artifact') {
    // An external agent writes as the model — never as the user.
    const body = (await api('/api/artifacts', { ...args, author: 'model' })) as {
      ok: boolean
      artifact?: { id: string; path: string }
      error?: string
    }
    return body.ok && body.artifact
      ? { text: `ok: created ${body.artifact.id} at ${body.artifact.path}`, isError: false }
      : { text: `rejected: ${body.error}`, isError: true }
  }
  if (name === 'update_artifact') {
    const { id, ...patch } = args
    if (typeof id !== 'string' || !id) return { text: 'rejected: need an artifact id', isError: true }
    const body = (await api(`/api/artifacts?id=${encodeURIComponent(id)}&by=model`, patch, 'PUT')) as {
      ok: boolean
      artifact?: { path: string }
      error?: string
    }
    return body.ok ? { text: `ok: updated ${body.artifact?.path ?? id}`, isError: false } : { text: `rejected: ${body.error}`, isError: true }
  }
  if (name === 'link_artifact') {
    const body = (await api('/api/links', {
      fromKind: 'artifact',
      fromId: args.artifactId,
      toKind: args.kind,
      toId: args.id,
      role: args.role,
    })) as { ok: boolean; error?: string }
    return body.ok ? { text: 'ok: linked', isError: false } : { text: `rejected: ${body.error}`, isError: true }
  }
  if (name === 'goal_create') return goalWrite((await api('/api/goals', args)) as Parameters<typeof goalWrite>[0])
  if (name === 'goal_list') {
    const states = Array.isArray(args.states) ? args.states.filter((x): x is string => typeof x === 'string') : []
    const q = new URLSearchParams()
    if (states.length) q.set('states', states.join(','))
    if (typeof args.sourceItemId === 'string' && args.sourceItemId) q.set('item', args.sourceItemId)
    const body = (await api(`/api/goals${q.size ? `?${q}` : ''}`)) as { ok: boolean; error?: string }
    if (!body.ok) return { text: `failed: ${body.error}`, isError: true }
    const { ok: _ok, ...rest } = body
    return { text: JSON.stringify(rest, null, 2), isError: false }
  }
  if (name === 'goal_get') {
    if (typeof args.id !== 'string' || !args.id) return { text: 'rejected: need a goal id', isError: true }
    const body = (await api(`/api/goals/${encodeURIComponent(args.id)}?log=${LEAD_LOG_ENTRIES}`)) as { ok: boolean; error?: string }
    if (!body.ok) return { text: `failed: ${body.error}`, isError: true }
    const { ok: _ok, ...rest } = body
    return { text: JSON.stringify(rest, null, 2), isError: false }
  }
  const goalPath = { goal_propose_plan: 'plan', goal_log_append: 'log', goal_handoff_write: 'handoff' }[name]
  if (goalPath) {
    if (typeof args.goalId !== 'string' || !args.goalId) return { text: 'rejected: need a goalId', isError: true }
    return goalWrite((await api(`/api/goals/${encodeURIComponent(args.goalId)}/${goalPath}`, args)) as Parameters<typeof goalWrite>[0])
  }
  return { text: `unknown tool: ${name}`, isError: true }
}

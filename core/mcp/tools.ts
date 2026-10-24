/**
 * The junior MCP contract: one tool table, one dispatcher, two external
 * transports.
 *
 * The stdio shim (server/mcp.ts, dependency-free, for clients that spawn a
 * process) and the daemon's own streamable-HTTP endpoint (POST /mcp in
 * server/index.ts, for clients that take a URL) both import this file, so
 * they cannot drift. A tool that exists over stdio and not over HTTP is the
 * kind of gap nobody notices until an agent silently stops being able to file
 * work. The in-process SDK server that web chats get is defined separately
 * with zod in server/junior-mcp.ts, against the same `*Op` functions; a tool
 * exported here by name (HAND_OFF_TOOL) gives it its name, description and
 * answer, so the third door can't drift either.
 *
 * Everything routes through the daemon's HTTP API via the injected `api`, so
 * the SQLite single-writer stays the server process whichever door was used.
 */
import { HAND_OFF_NOTE_MAX, type HandoffReadiness } from '../work/handoff.js'
import type { SendCheck } from '../actions/types.js'

/** How a transport reaches the junior API. Returns the parsed JSON body. */
export type McpApi = (path: string, body?: unknown, method?: string) => Promise<unknown>

/** What this connection is, for get_workspace to report back honestly. */
export type Connection = { serverUrl: string; requestedWorkspace: string | null }

export type ToolResult = { text: string; isError: boolean }

/** draft_job's skills/agents arguments, said once for every transport. */
export const SKILLS_ARG =
  'skills the runs may load, as Claude calls them: junior:<name> for the workspace library, <name> for personal ones, <plugin>:<name>. Only these load; omit for none'
export const AGENTS_ARG = 'subagents the runs may hand work to, named the same way. Only these start; omit for none'
/** draft_job's browser arguments: when to set them, and the question to ask first. */
export const BROWSER_ARG =
  'a browser profile id or name (Settings → Browser) when the job reads web pages, e.g. a dashboard the user signs in to. Runs get the browser, signed in as it, and may read but never press Send or Save. Ask which profile first, suggesting the workspace default'
export const BROWSER_SITES_ARG =
  'with browser: the only hosts runs may open, e.g. ["app.pendo.io"] or ["*.pendo.io"]; take them from the pages the job reads. Default = any site'

/**
 * hand_off_work_item: one table entry for all three doors. The in-process
 * server (server/junior-mcp.ts) takes its name, description and argument
 * descriptions from here, and answers through handOffAnswer like the
 * dispatcher below.
 */
export const HAND_OFF_TOOL = {
  name: 'hand_off_work_item',
  description:
    "Hand one work item to Junior, by id. The user's own PR: Junior babysits it (CI, review threads, rebases). A review request: Junior does a first pass. Anything else: Junior starts its playbook (answer, debug-fix or investigate). Junior works only what is handed off, and every send still waits for the user's OK. The answer carries readiness: if a watch is off, nothing runs yet. Tell the user; only they turn it on, in Settings → Automations. To hand off something new, create it with create_work_item first and pass the id it returns.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'the work item, e.g. "github:owner/repo#12" or "manual:<uuid>"' },
      note: {
        type: 'string',
        description: `one line for Junior: a pointer, not an explanation, e.g. "the flaky test is in auth.spec". Every task on the item reads it. ${HAND_OFF_NOTE_MAX} characters at most`,
      },
    },
    required: ['id'],
  },
}

/** What a hand-off answers on every door: one sentence for the model to act on, then readiness as JSON. */
export function handOffAnswer(id: string, readiness: HandoffReadiness): string {
  const said =
    readiness.state === 'ready'
      ? `ok: handed ${id} to Junior. Junior is on it.`
      : readiness.state === 'watch-off'
        ? `ok: handed ${id} to Junior, but ${readiness.watch === 'babysit' ? 'babysitting is off' : 'first-pass reviews are off'}, so nothing runs yet. Tell the user: they turn it on in Settings → Automations. Don't turn it on yourself.`
        : `ok: handed ${id} to Junior, but nothing runs on it: ${readiness.why}.`
  return `${said}\nreadiness: ${JSON.stringify(readiness)}`
}

/**
 * check_send: one table entry for all three doors, like hand_off_work_item.
 * A dry run of the send policy (core/actions/check.ts) for any agent on this
 * Mac. It reads; it never runs, sends or queues anything.
 */
export const CHECK_SEND_TOOL = {
  name: 'check_send',
  description:
    "Ask Junior whether a call would go out as the user, before you make it. A dry run of the user's send policy: it never runs, sends or queues anything. Pass the tool name and its arguments. The answer is free (local work, a read, a push to a branch that isn't the default one, a draft PR, or a send the user approved in advance), held (it reaches a person, so it waits for the user's OK), destroys (it throws away work, so ask the user first) or refused (only the user approves sends, in the app), with one sentence why. Junior's own chats are held by this policy; anywhere else, follow the answer yourself: on held or destroys, show the user what you would send and wait.",
  inputSchema: {
    type: 'object',
    properties: {
      tool: { type: 'string', description: 'the tool as you would call it: "Bash", "Edit", "Write", or "mcp__<server>__<tool>" (e.g. "mcp__slack__send_message")' },
      input: {
        type: 'object',
        description: 'its arguments, as you would pass them. For Bash: { "command": "git push origin main" }',
      },
      cwd: {
        type: 'string',
        description: 'for Bash: the absolute folder the command runs in, so a push with no branch named is judged against the branch checked out there. Without it, such a push is held',
      },
    },
    required: ['tool'],
  },
}

/** What check_send answers on every door: the verdict and why on one line, then the whole check as JSON. */
export function checkSendAnswer(check: SendCheck): string {
  return `${check.verdict}: ${check.why}\ncheck: ${JSON.stringify(check)}`
}

/** The MCP revision both transports speak. */
export const PROTOCOL_VERSION = '2024-11-05'

export const TOOLS = [
  {
    name: 'list_work_items',
    description:
      'Read the ranked junior queue: work items with their deterministic score, group, and rankWhy (why it ranked). Open items by default — pass status to read the done, snoozed or archived lists instead. Optional filters narrow by source or kind.',
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
      "What a junior session is: its workspace, the work item it was opened for (with that item's brief and notes), and the artifacts attached to it. The ids it returns are what write_artifact's `links` needs.",
    inputSchema: {
      type: 'object',
      properties: { sessionId: { type: 'string', description: 'a junior session id' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'get_workspace',
    description:
      'Which junior workspace this connection is acting in: `current` (id, name, whether it is the default, auth backend) plus `workspaces`, the roster of ids to switch among. This connection picks its workspace with the JUNIOR_WORKSPACE env var; an id that matches no workspace is refused by every other tool, and this one reports the id you requested and whether it matched. Everything you list/create/edit here lives in `current`.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'upsert_work_item',
    description:
      'Idempotently upsert one work item into the junior inbox. Id-keyed (e.g. "slack:<permalink-tail>", "github:owner/repo#123"), update-only-if-newer (by updatedAt), user-state-preserving: calling this repeatedly can never create duplicates or clobber done/snoozed/dismissed state. Invalid items are rejected, never repaired.',
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
        browser: { type: 'string', description: BROWSER_ARG },
        browser_sites: { type: 'array', items: { type: 'string' }, description: BROWSER_SITES_ARG },
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
  HAND_OFF_TOOL,
  CHECK_SEND_TOOL,
  // Today's plan (core/junior/today.ts): one list for the user and Junior per local day.
  {
    name: 'get_today',
    description:
      "Today's plan: the work items the user and Junior mean to get through today, each with an owner and a status. Done comes from the item itself; unfinished rows from earlier days carry over and say so.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_to_today',
    description:
      "Put a work item on today's plan, or change whose it is today. Find the item first (list_work_items); if there is none, create it with create_work_item and pass its id.",
    inputSchema: {
      type: 'object',
      properties: {
        itemId: { type: 'string', description: 'the work item, e.g. "github:owner/repo#12" or "manual:<uuid>"' },
        owner: { type: 'string', enum: ['user', 'junior'], description: 'whose it is today: the user, or Junior' },
      },
      required: ['itemId', 'owner'],
    },
  },
  {
    name: 'remove_from_today',
    description: "Take a work item off today's plan. The item itself is untouched: it stays in the inbox, at its status.",
    inputSchema: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'] },
  },
  // Artifacts: files beside the inbox (.docs/next-version.md): notes, briefs, pages, tables, images.
  {
    name: 'list_artifacts',
    description:
      "List the workspace's artifacts — files kept beside the work items (notes, briefs, pages, tables, images) — with id, title, format, version, author (human|model), refs, path and links.",
    inputSchema: {
      type: 'object',
      properties: { all: { type: 'boolean', description: 'include briefs of finished items (hidden by default)' } },
    },
  },
  {
    name: 'read_artifact',
    description:
      'Read one artifact by id: title, format, version, author, refs, path on disk and the full text (markdown without its frontmatter). A pdf or image has no text here: you get the header and the path. Pass version to read an older one.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        version: { type: 'number', description: 'an older version; omit for the current one' },
      },
      required: ['id'],
    },
  },
  {
    name: 'write_artifact',
    description:
      "Publish a file as an artifact: a document, page, table, image or other output the user should open. Every version is kept. Text formats (md, html, csv, txt, json, svg): pass title, body and format. Binary or script-made files (pdf, png, jpg, gif, webp, or anything big): make the file, then pass from with its absolute path, inside the system temp folder (junior copies it). To change an artifact you already published, call update_artifact with its id. Never write report-v2.html. Files over 25 MB are refused. Returns the id and version.",
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        format: {
          type: 'string',
          enum: ['md', 'html', 'csv', 'txt', 'json', 'svg', 'pdf', 'png', 'jpg', 'gif', 'webp'],
          description: 'md (default), html, csv, txt, json or svg: send them as body. pdf, png, jpg, gif, webp, or any big or script-made file: use from.',
        },
        body: { type: 'string', description: 'the content, for md html csv txt json svg. Up to 2 MB; bigger goes through from.' },
        from: {
          type: 'string',
          description: 'absolute path of a file you made, in the temp folder. junior copies it; later edits to the original do not change the artifact.',
        },
        note: { type: 'string', description: 'one line about this version (500 characters at most)' },
        refs: { type: 'array', items: { type: 'string' }, description: 'PR/issue URLs or Linear keys it is about' },
        links: {
          type: 'array',
          description: 'extra links. Pass { kind: "session", id, role: "output" } to show it under a session.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['item', 'session'] },
              id: { type: 'string' },
              role: { type: 'string', enum: ['brief', 'context', 'dispatch', 'output'] },
            },
            required: ['kind', 'id', 'role'],
          },
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_artifact',
    description:
      'Publish a new version of a model-authored artifact: same id, history kept. Pass the new body (text formats) or from (a file path), and a note: one line on what changed. Use this instead of writing a second artifact such as report-v2.html. The format cannot change. For non-markdown files, a title or refs change alone does not make a new version. Human-authored artifacts are refused — propose the change to the user instead.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
        from: { type: 'string', description: 'absolute path of a file you made, in the temp folder; junior copies it' },
        note: { type: 'string', description: 'one line on what changed in this version (500 characters at most)' },
        refs: { type: 'array', items: { type: 'string' } },
      },
      required: ['id'],
    },
  },
  {
    name: 'link_artifact',
    description: 'Link an existing artifact to a work item or session with a role (usually "context"; "output" for a file a session published).',
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string' },
        kind: { type: 'string', enum: ['item', 'session'] },
        id: { type: 'string' },
        role: { type: 'string', enum: ['brief', 'context', 'dispatch', 'output'] },
      },
      required: ['artifactId', 'kind', 'id', 'role'],
    },
  },
]

export async function callTool(
  api: McpApi,
  conn: Connection,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (name === 'list_work_items') {
    // 'open' is the live inbox (a scan); every other status is a plain read of
    // the durable store: the same split the server makes internally. The
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
    // workspace that does not match, it fell back to the default, say so
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
    const body = (await api('/api/items/manual', args)) as { ok: boolean; id?: string; error?: string }
    // the id is what hand_off_work_item and add_to_today need next
    return body.ok ? { text: body.id ? `ok: created ${body.id}` : 'ok: created', isError: false } : { text: `rejected: ${body.error}`, isError: true }
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
  if (name === HAND_OFF_TOOL.name) {
    if (typeof args.id !== 'string' || !args.id) return { text: 'rejected: need a work-item id', isError: true }
    if (args.note !== undefined && typeof args.note !== 'string') return { text: 'rejected: note is one line of text', isError: true }
    const body = (await api('/api/handoff/start', { itemId: args.id, ...(args.note ? { note: args.note } : {}) })) as {
      ok: boolean
      readiness?: HandoffReadiness
      error?: string
    }
    if (!body.ok) return { text: `rejected: ${body.error}`, isError: true }
    if (!body.readiness) return { text: `ok: handed ${args.id} to Junior`, isError: false }
    return { text: handOffAnswer(args.id, body.readiness), isError: false }
  }
  if (name === CHECK_SEND_TOOL.name) {
    if (typeof args.tool !== 'string' || !args.tool.trim()) return { text: 'rejected: need the tool name, e.g. "Bash"', isError: true }
    if (args.input !== undefined && (!args.input || typeof args.input !== 'object' || Array.isArray(args.input)))
      return { text: 'rejected: input is the call\'s arguments, a JSON object', isError: true }
    if (args.cwd !== undefined && typeof args.cwd !== 'string') return { text: 'rejected: cwd is an absolute folder path', isError: true }
    const body = (await api('/api/actions/check', { tool: args.tool, input: args.input ?? {}, ...(args.cwd ? { cwd: args.cwd } : {}) })) as {
      ok: boolean
      check?: SendCheck
      error?: string
    }
    if (!body.ok || !body.check) return { text: `rejected: ${body.error ?? 'no answer'}`, isError: true }
    return { text: checkSendAnswer(body.check), isError: false }
  }
  if (name === 'get_today') {
    const body = (await api('/api/today')) as { ok: boolean; plan?: unknown; error?: string }
    return body.ok ? { text: JSON.stringify(body.plan, null, 2), isError: false } : { text: `failed: ${body.error}`, isError: true }
  }
  if (name === 'add_to_today') {
    if (typeof args.itemId !== 'string' || !args.itemId) return { text: 'rejected: need a work-item id', isError: true }
    if (args.owner !== 'user' && args.owner !== 'junior') return { text: 'rejected: owner is "user" or "junior"', isError: true }
    const body = (await api('/api/today/add', { itemId: args.itemId, owner: args.owner, by: 'junior' })) as { ok: boolean; error?: string }
    return body.ok ? { text: "ok: on today's plan", isError: false } : { text: `rejected: ${body.error}`, isError: true }
  }
  if (name === 'remove_from_today') {
    if (typeof args.itemId !== 'string' || !args.itemId) return { text: 'rejected: need a work-item id', isError: true }
    const body = (await api('/api/today/remove', { itemId: args.itemId })) as { ok: boolean; error?: string }
    return body.ok ? { text: 'ok: removed', isError: false } : { text: `rejected: ${body.error}`, isError: true }
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
    const v = typeof args.version === 'number' && Number.isInteger(args.version) && args.version >= 1 ? `&v=${args.version}` : ''
    const body = (await api(`/api/artifacts/content?id=${encodeURIComponent(args.id)}${v}`)) as {
      ok: boolean
      artifact?: { title: string; id: string; author: string; refs: string[]; format?: string; version?: number }
      body?: string
      abs?: string
      version?: number
      latest?: boolean
      binary?: boolean
      truncated?: boolean
      error?: string
    }
    if (!body.ok || !body.artifact) return { text: `failed: ${body.error ?? 'no such artifact'}`, isError: true }
    const a = body.artifact
    const head = [`title: ${a.title}`, `id: ${a.id}`]
    if (a.format) head.push(`format: ${a.format}`)
    if (body.version) head.push(`version: ${body.version}${body.latest === false ? ` (current is v${a.version})` : ''}`)
    head.push(`author: ${a.author}`, `path: ${body.abs ?? ''}`)
    if (a.refs.length) head.push(`refs: ${a.refs.join(', ')}`)
    if (body.truncated) head.push('note: the text is cut at 2 MB')
    if (body.binary) return { text: [...head, 'note: binary file, no text here; open the path'].join('\n'), isError: false }
    return { text: `${head.join('\n')}\n\n${body.body ?? ''}`, isError: false }
  }
  if (name === 'write_artifact') {
    // An external agent writes as the model, never as the user.
    const body = (await api('/api/artifacts', { ...args, author: 'model' })) as {
      ok: boolean
      artifact?: { id: string; path: string; format?: string }
      version?: number
      error?: string
    }
    return body.ok && body.artifact
      ? { text: `ok: created ${body.artifact.id} (${body.artifact.format ?? 'md'}, v${body.version ?? 1}) at ${body.artifact.path}`, isError: false }
      : { text: `rejected: ${body.error}`, isError: true }
  }
  if (name === 'update_artifact') {
    const { id, ...patch } = args
    if (typeof id !== 'string' || !id) return { text: 'rejected: need an artifact id', isError: true }
    const body = (await api(`/api/artifacts?id=${encodeURIComponent(id)}&by=model`, patch, 'PUT')) as {
      ok: boolean
      artifact?: { path: string }
      action?: string
      version?: number
      error?: string
    }
    if (!body.ok) return { text: `rejected: ${body.error}`, isError: true }
    const where = `${id} (v${body.version ?? '?'}) ${body.artifact?.path ?? ''}`.trimEnd()
    return {
      text: body.action === 'unchanged' ? `ok: unchanged ${where} — no new version: identical content` : `ok: updated ${where}`,
      isError: false,
    }
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
  return { text: `unknown tool: ${name}`, isError: true }
}

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { TRIAGE_MCP_INSTRUCTIONS } from '../shared/triageContext.js'
import { AGENTS_ARG, SKILLS_ARG } from '../core/mcp/tools.js'
import { type Label, LABEL_ORDER } from '../core/work/labels.js'
import { WorkspaceRuntime } from './workspace/runtime.js'
import { VERSION } from './config.js'
import { teamLeadTools } from './team-run/mcp.js'
import { createManualOp, editManualOp, itemDetailOp, listItemsOp, resolveItemOp, sessionContextOp, upsertItemOp } from './items-ops.js'
import { addToTodayOp, ensureToday, removeFromTodayOp, savePersonaOp, todayJson, todayView } from './junior-ops.js'
import { errText } from './errors.js'
import { workspaceInfo } from './workspace/wiring.js'
import { draftJobOp, draftJobText, tryJobOp } from './jobs/ops.js'
import { addLinkOp, createArtifactOp, listArtifactsOp, updateArtifactOp } from './artifacts-ops.js'

export const okResult = (text: string) => ({ content: [{ type: 'text' as const, text }] })
export const errResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

export function makeTriageMcp(rt: WorkspaceRuntime) {
  return createSdkMcpServer({
    name: 'triage',
    version: VERSION,
    // Always load triage's tools, never defer them behind tool search — and,
    // as a documented side effect, block session startup until this server is
    // connected (capped at the SDK's 5s connect timeout). Without it, when the
    // user has many ~/.claude connectors, triage loses the init connection race
    // ("connector storm") and lands `status: "failed"` in system/init, leaving
    // a chat with no mcp__triage__* tools so it falls back to the HTTP API.
    // triage is in-process and connects in ~ms, so this guarantees its tools
    // are present on turn 1 without slowing startup or dropping any connector.
    alwaysLoad: true,
    // What triage is, in the one place the SDK will show a model before it
    // picks a tool. Static by construction (shared/triageContext.ts) so it
    // caches, and shared verbatim with the stdio shim — one contract, two
    // transports, one explanation of it.
    instructions: TRIAGE_MCP_INSTRUCTIONS,
    tools: [
      // Teams v2: any chat can become a lead (list_teams, propose_team, split_step, submit_step).
      ...teamLeadTools(rt),
      // Goals are team runs with a done-when now (propose_team's `goal`); the old goals engine's
      // goal_* tools stay in server/goals.ts but no chat is offered them.
      tool(
        'list_work_items',
        'Read the ranked triage queue: work items with their score, group, and reason. Open items by default — pass status to read the done, snoozed or archived lists instead. Optional filters narrow by source or kind.',
        {
          status: z.enum(['open', 'snoozed', 'done', 'archived']).optional().describe('which list to read (default "open")'),
          source: z.enum(['github', 'slack', 'linear', 'manual']).optional().describe('only items from this source'),
          kind: z.string().optional().describe('only items of this kind, e.g. "job-hit"'),
        },
        async (args) => {
          try {
            const items = await listItemsOp(rt, { source: args.source, kind: args.kind, status: args.status })
            return okResult(JSON.stringify(items, null, 2))
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      // Today's plan (core/junior/today.ts): get_today is a free read; the two writes prompt like any write.
      tool(
        'get_today',
        "Today's plan: the work items the user and you mean to get through today, each with an owner (the user, or you) and a status. Done comes from the item itself; unfinished rows carried over from earlier days say so. Read it before planning work, and when the user mentions today.",
        {},
        async () => {
          try {
            return okResult(todayJson(await todayView(rt, await ensureToday(rt))))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'add_to_today',
        "Put a work item on today's plan, or change whose it is today. Find the item first (list_work_items); if there is none, create it with create_work_item and pass its id. Ask whose it is when the user didn't say.",
        {
          itemId: z.string().describe('the work item, e.g. "github:owner/repo#12" or "manual:<uuid>"'),
          owner: z.enum(['user', 'junior']).describe('whose it is today: "user" = the user does it, "junior" = you do'),
        },
        async (args) => {
          try {
            const { plan } = await addToTodayOp(rt, args, 'junior')
            return okResult(`ok: ${args.itemId} is on today's plan, owned by ${args.owner === 'user' ? 'the user' : 'you'}\n${todayJson(plan)}`)
          } catch (err) {
            return errResult(`not added: ${errText(err)}`)
          }
        },
      ),
      tool(
        'remove_from_today',
        "Take a work item off today's plan. The item itself is untouched: it stays in the inbox, at its status.",
        { itemId: z.string().describe('the work item on the plan') },
        async (args) => {
          try {
            const { removed, plan } = await removeFromTodayOp(rt, args)
            return okResult(`${removed ? 'ok: removed' : 'it was not on today\'s plan'}\n${todayJson(plan)}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'set_reply_style',
        "Save how you reply to the user, in their words (About me → How I reply to you). Use it when they tell you how they want replies: tone, length, format. It shapes how you talk, never what you may do; the rules stay. Applies to new sessions.",
        { text: z.string().max(400).describe("the user's preference, in a sentence or two, in their words; empty clears it") },
        async (args) => {
          try {
            const p = await savePersonaOp(rt, { replyStyle: args.text })
            return okResult(p.replyStyle ? `ok: saved. New sessions read: "${p.replyStyle}"` : 'ok: cleared')
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'get_work_item',
        'Everything about one work item by id, at any status: the item, its rank if it is in the open inbox, the items sharing a ref with it, the artifacts linked to it (its brief and any context notes) and the sessions that worked it. Use this to follow an id from list_work_items, from a linked sibling, or from get_session_context.',
        { id: z.string().describe('a work-item id, e.g. "github:owner/repo#12" or "manual:<uuid>"') },
        async (args) => {
          try {
            return okResult(JSON.stringify(await itemDetailOp(rt, args.id), null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'get_session_context',
        'What this session is: its workspace, the work item it was opened for (with that item\'s brief and notes), and the artifacts attached to it. Your own triage session id is in your system prompt. Call this before writing a note "here" — the ids it returns are what write_artifact\'s `links` needs.',
        { sessionId: z.string().describe('a triage session id — yours is named in your system prompt') },
        async (args) => {
          try {
            return okResult(JSON.stringify(await sessionContextOp(rt, args.sessionId), null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'get_workspace',
        'Which triage workspace you are acting in: `current` (its id, name, whether it is the default, and its auth backend) plus `workspaces`, the full roster of ids to switch among. Everything you list/create/edit here lives in `current`. An external Claude Code session picks its workspace with the TRIAGE_WORKSPACE env var (an unknown id silently falls back to the default) — call this to confirm which one you actually landed in.',
        {},
        async () => {
          try {
            return okResult(JSON.stringify(workspaceInfo(rt), null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'draft_job',
        'Draft a job — a scheduled headless run that files matches as work items (or writes a digest). It is saved OFF as a draft: only the user can enable it, from the job page this returns a link to. Use when the user asks to run something on a schedule, monitor it or keep an eye on it.',
        {
          title: z.string().describe('a short name, e.g. "Anirudha’s PRs"'),
          schedule: z.string().describe('a 5-field cron line in local time: "0 * * * *" hourly, "0 9 * * 1-5" weekdays at 9'),
          instruction: z.string().describe('where to look, what counts as a match, what to file — written for the run, which sees only this'),
          project: z.string().optional().describe('the project folder runs work in: an id or a name; default = the default project'),
          tools: z
            .array(z.string())
            .optional()
            .describe('what runs may use, one per entry: built-ins web, github, files-write, or "<server>/<tool>" for an MCP tool; default [web]'),
          output: z.enum(['items', 'digest']).optional().describe('items (one work item per match, default) or digest (one rolling report)'),
          model: z.string().optional().describe('model for the runs; default = Claude Code’s'),
          brief: z.boolean().optional().describe('brief every item it files (items output only)'),
          brief_model: z.string().optional().describe('model for the briefs; default = the workspace’s brief default'),
          brief_template: z.string().optional().describe('playbook to brief with, e.g. "review-requested"; default = the item’s kind'),
          skills: z.array(z.string()).optional().describe(SKILLS_ARG),
          agents: z.array(z.string()).optional().describe(AGENTS_ARG),
        },
        async (args) => {
          try {
            return okResult(draftJobText(await draftJobOp(rt, args), true))
          } catch (err) {
            return errResult(`not drafted: ${errText(err)}`)
          }
        },
      ),
      tool(
        'try_job',
        'Trial-run a job once, as a dry run: the same prompt, tools and fences as a real run, but nothing is filed or sent. Waits for the run (a few minutes at most) and returns what it would have filed. Use after draft_job, when the user agrees to a trial run.',
        { id: z.string().describe('the job id draft_job returned') },
        async (args) => {
          try {
            return okResult(await tryJobOp(rt, args))
          } catch (err) {
            return errResult(`trial run failed: ${errText(err)}`)
          }
        },
      ),
      tool(
        'create_work_item',
        'Add a manual to-do to the inbox (a user-authored item). Title is required; description, url, urls, priority (1–4), due (ISO day), and projectId are optional.',
        {
          title: z.string().describe('what the to-do is'),
          description: z.string().optional().describe("the user's intent in a few sentences"),
          note: z.string().optional().describe('alias of description'),
          url: z.string().optional().describe('an http(s) link'),
          urls: z.array(z.string()).optional().describe('more http(s) links — the Slack thread, the PR, a doc'),
          priority: z.number().int().min(1).max(4).optional(),
          projectId: z.string().optional().describe('an existing project id'),
          due: z.string().optional().describe('due day, ISO 8601 (e.g. 2026-10-21)'),
        },
        async (args) => {
          try {
            const id = await createManualOp(rt, args)
            return okResult(`ok: created ${id}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'edit_work_item',
        'Edit a manual to-do by id (id must start with "manual:"). Only the fields you pass change; priority 0/null and due null clear them.',
        {
          id: z.string().describe('the manual item id, e.g. "manual:<uuid>"'),
          title: z.string().optional(),
          description: z.string().optional(),
          note: z.string().optional().describe('alias of description'),
          url: z.string().optional(),
          urls: z.array(z.string()).optional().describe('the complete list of extra links; [] clears them'),
          priority: z.number().int().min(0).max(4).nullable().optional(),
          projectId: z.string().optional(),
          due: z.string().nullable().optional().describe('due day, ISO 8601 (e.g. 2026-10-21), or null to clear'),
        },
        async (args) => {
          try {
            const { id, ...patch } = args
            await editManualOp(rt, id, patch)
            return okResult(`ok: edited ${id}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'upsert_work_item',
        'Idempotently upsert one ingested work item (for scanners). Id-keyed, update-only-if-newer by updatedAt, user-state-preserving: repeated calls never create duplicates or clobber done/snoozed/dismissed state. Invalid items are rejected, never repaired.',
        {
          id: z.string().describe('stable id: "slack:...", "github:owner/repo#123", or "linear:KEY-123"'),
          kind: z.string().describe('item kind, e.g. "job-hit", "mention", "fyi"'),
          title: z.string(),
          url: z.string(),
          updatedAt: z.string().describe('ISO 8601 — the upsert applies only if newer than what is stored'),
          repo: z.string().optional(),
          author: z.string().optional(),
          peopleWaiting: z.number().optional(),
          createdAt: z.string().optional(),
          jobId: z.string().optional(),
          why: z.string().optional(),
          ask: z.enum(LABEL_ORDER as [Label, ...Label[]]).optional().describe('what it asks of the user (job hits)'),
          due: z.string().optional().describe('a deadline the source states, ISO 8601 day'),
          refs: z.array(z.string()).optional(),
        },
        async (args) => {
          try {
            const outcome = await upsertItemOp(rt, args)
            return okResult(`ok: ${outcome}`)
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      tool(
        'resolve_work_item',
        'Mark one work item done (by id). Subject to the re-arm rule: if the source updates afterwards, the item returns to the inbox.',
        { id: z.string() },
        async (args) => {
          try {
            await resolveItemOp(rt, args.id)
            return okResult('ok: done')
          } catch (err) {
            return errResult(err instanceof Error ? err.message : String(err))
          }
        },
      ),
      // Artifacts: the user's markdown notes and briefs beside the inbox
      // (.docs/next-version.md). Reads are auto-allowed; writes prompt like
      // every other triage write, and the model may only rewrite its own.
      tool(
        'list_artifacts',
        "List this workspace's artifacts — markdown notes and briefs kept beside the work items — with id, title, author (human|model), refs, path and links. Read one with read_artifact.",
        { all: z.boolean().optional().describe('include briefs of finished (done/archived) items, hidden by default') },
        async (args) => {
          try {
            const rows = await listArtifactsOp(rt, args.all === true)
            return okResult(JSON.stringify(rows.map(({ mtime, size, ...a }) => (void mtime, void size, a)), null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'read_artifact',
        'Read one artifact by id: title, author, refs, its path on disk, and the full markdown body.',
        { id: z.string().describe('the artifact id from list_artifacts') },
        async (args) => {
          try {
            const a = await rt.artifacts.read(args.id)
            if (!a) return errResult('no such artifact')
            const head = [
              `title: ${a.artifact.title}`,
              `id: ${a.artifact.id}`,
              `author: ${a.artifact.author}`,
              `path: ${a.abs}`,
              a.artifact.refs.length ? `refs: ${a.artifact.refs.join(', ')}` : undefined,
            ].filter((l): l is string => typeof l === 'string')
            return okResult(`${head.join('\n')}\n\n${a.body}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'write_artifact',
        'Create a new artifact (a markdown note authored by you, the model) in the workspace, optionally linked to a work item or session as context. Returns its id. Use update_artifact to change it later.',
        {
          title: z.string().describe('a short title'),
          body: z.string().describe('the markdown body'),
          refs: z.array(z.string()).optional().describe('GitHub PR/issue URLs or Linear keys this note is about'),
          links: z
            .array(
              z.object({
                kind: z.enum(['item', 'session']),
                id: z.string(),
                role: z.enum(['brief', 'context', 'dispatch']),
              }),
            )
            .optional()
            .describe('attach to a work item or session; role is usually "context"'),
        },
        async (args) => {
          try {
            const a = await createArtifactOp(rt, args, 'model')
            return okResult(`ok: created ${a.id} at ${a.path}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'update_artifact',
        'Rewrite an artifact you (the model) authored, in place: any of title, body, refs. Human-authored artifacts are refused — propose the change to the user instead.',
        {
          id: z.string(),
          title: z.string().optional(),
          body: z.string().optional(),
          refs: z.array(z.string()).optional(),
        },
        async (args) => {
          try {
            const { id, ...patch } = args
            const a = await updateArtifactOp(rt, id, patch, 'model')
            return okResult(`ok: updated ${a.path}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'link_artifact',
        'Link an existing artifact to a work item or session with a role ("context" for notes to read alongside; "brief" only for the document about an item).',
        {
          artifactId: z.string(),
          kind: z.enum(['item', 'session']),
          id: z.string(),
          role: z.enum(['brief', 'context', 'dispatch']),
        },
        async (args) => {
          try {
            const l = await addLinkOp(rt, { fromKind: 'artifact', fromId: args.artifactId, toKind: args.kind, toId: args.id, role: args.role })
            return okResult(`ok: linked ${l.id}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
    ],
  })
}

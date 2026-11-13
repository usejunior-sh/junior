import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { JUNIOR_MCP_INSTRUCTIONS } from '../shared/juniorContext.js'
import { AGENTS_ARG, BROWSER_ARG, BROWSER_SITES_ARG, CHECK_SEND_TOOL, checkSendAnswer, HAND_OFF_TOOL, handOffAnswer, SKILLS_ARG } from '../core/mcp/tools.js'
import { checkSendOp } from './session/actions-check.js'
import { handoffOp } from './handoff-ops.js'
import { type Ask, ASK_ORDER } from '../core/work/asks.js'
import { WorkspaceRuntime } from './workspace/runtime.js'
import { VERSION } from './config.js'
import { teamLeadTools } from './team-run/mcp.js'
import { createManualOp, editManualOp, itemDetailOp, listItemsOp, resolveItemOp, sessionContextOp, upsertItemOp } from './items-ops.js'
import { addToTodayOp, ensureToday, removeFromTodayOp, savePersonaOp, todayJson, todayView } from './junior-ops.js'
import { errText } from './errors.js'
import { endFocusOp, getFocusHoursOp, setFocusHoursOp } from './settings-ops.js'
import { workspaceInfo } from './workspace/wiring.js'
import { draftJobOp, draftJobText, tryJobOp } from './jobs/ops.js'
import { addLinkOp, createArtifactOp, listArtifactsOp, toolResult, updateArtifactOp } from './artifacts-ops.js'
import { listApprovalsOp } from './approvals-ops.js'
import { proposeLearningOp } from './learnings-ops.js'
import { proposeLearningResult } from '../core/junior/learnings.js'
import { listPinsOp, pinNoteOp, unpinOp } from './pins-ops.js'
import { recentWork, WORKLOG_KEEP_DAYS, worklogLine } from '../core/junior/worklog.js'
import { worklogFor } from './worklog-ops.js'
import { forgetOp, memoryForPrompt, rememberOp } from './memory-ops.js'
import { MEMORY_MAX_BYTES, memoryLine } from '../core/junior/memory.js'
import { APPROVAL_WHATS, approvalFrom, describeApproval, isLive } from '../core/approvals/approvals.js'
import { messageSessionOp, sessionByName, sessionReport, startedBy, startSessionsOp } from './session/spawn-ops.js'
import { MAX_FORWARDED } from './attachments.js'

export const okResult = (text: string) => ({ content: [{ type: 'text' as const, text }] })
export const errResult = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

/** start_session / message_session: files that go with the message, as the thread's own attachments (server/attachments.ts readForwarded). */
const ATTACHMENTS_ARG = z
  .array(z.string())
  .max(MAX_FORWARDED)
  .optional()
  .describe(
    'absolute paths of images and files to send with it, as real attachments the thread sees, copied now so a temp file can\'t vanish. Pass every image and file the user attached: an image\'s path is in its "[Image: source: …]" line, a file\'s in the attached-files note',
  )

/**
 * `sessionId` is the chat this server instance belongs to (one instance per
 * session, see WorkspaceRuntime.juniorMcp). The artifact writes use it to link
 * what the session publishes to the session, so the model never has to pass it.
 */
export function makeJuniorMcp(rt: WorkspaceRuntime, sessionId?: string) {
  return createSdkMcpServer({
    name: 'junior',
    version: VERSION,
    // Always load junior's tools, never defer them behind tool search, and,
    // as a documented side effect, block session startup until this server is
    // connected (capped at the SDK's 5s connect timeout). Without it, when the
    // user has many ~/.claude connectors, junior loses the init connection race
    // ("connector storm") and lands `status: "failed"` in system/init, leaving
    // a chat with no mcp__junior__* tools so it falls back to the HTTP API.
    // Junior is in-process and connects in ~ms, so this guarantees its tools
    // are present on turn 1 without slowing startup or dropping any connector.
    alwaysLoad: true,
    // What Junior is, in the one place the SDK will show a model before it
    // picks a tool. Static by construction (shared/juniorContext.ts) so it
    // caches, and shared verbatim with the stdio shim, one contract, two
    // transports, one explanation of it.
    instructions: JUNIOR_MCP_INSTRUCTIONS,
    tools: [
      // Teams v2: any chat can become a lead (list_teams, propose_team, split_step, submit_step).
      ...teamLeadTools(rt),
      // Goals are team runs with a done-when (propose_team's `goal`).
      tool(
        'list_work_items',
        'Read the ranked junior queue: work items with their score, group, and rankWhy (why it ranked). Open items by default — pass status to read the done, snoozed or archived lists instead. Optional filters narrow by source or kind.',
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
      // Focus hours (core/work/focus.ts): set by chat, never a form. The read is free; setting and ending prompt like any write.
      tool(
        'get_focus_hours',
        'The user\'s focus hours: the windows, how long a person must wait to get through, and whether focus is on right now (until when). During focus only people waiting past that time and prod-red items reach Needs you; the rest is held until it ends.',
        {},
        async () => {
          try {
            return okResult(JSON.stringify(await getFocusHoursOp(rt), null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'set_focus_hours',
        'Set the user\'s focus hours when they ask for deep-work time ("focus 9–12 on weekdays"). Replaces what was set; an empty windows list clears it. During a window only people waiting at least waitMinutes and prod-red items (urgent, or from an incident tool) reach Needs you; everything else is held until the window ends. Times are the Mac\'s local time. Ask the wait only if they mention it; it defaults to 60 minutes.',
        {
          windows: z
            .array(
              z.object({
                days: z.union([z.string(), z.array(z.string())]).describe('"weekdays", "weekends", "every day", or day names like ["mon", "wed"]'),
                start: z.string().describe('local clock time, e.g. "9:00" or "9am"'),
                end: z.string().describe('local clock time, e.g. "12:00"; before the start = runs past midnight'),
              }),
            )
            .max(14)
            .describe('the focus windows; empty clears focus hours'),
          waitMinutes: z.number().int().min(0).max(10080).optional().describe('a person waiting this many minutes gets through (default 60)'),
        },
        async (args) => {
          try {
            const view = await setFocusHoursOp(rt, args)
            return okResult(`ok: ${view.text}${view.now ? ` Focus is on now, until ${new Date(view.now.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.` : ''}`)
          } catch (err) {
            return errResult(`not set: ${errText(err)}`)
          }
        },
      ),
      tool(
        'end_focus',
        'End the current focus window early, when the user says they are done focusing. Held items come back to Needs you; the next window starts as set.',
        {},
        async () => {
          try {
            const before = await getFocusHoursOp(rt)
            if (!before.now) return okResult('Focus is not on right now; nothing to end.')
            await endFocusOp(rt)
            return okResult('ok: focus ended. Everything held is back on Needs you.')
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
        'What this session is: its workspace, the work item it was opened for (with that item\'s brief and notes), and the artifacts attached to it. Your own junior session id is in your system prompt. Call this before writing a note "here" — the ids it returns are what write_artifact\'s `links` needs.',
        { sessionId: z.string().describe('a junior session id — yours is named in your system prompt') },
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
        'Which junior workspace you are acting in: `current` (its id, name, whether it is the default, and its auth backend) plus `workspaces`, the full roster of ids to switch among. Everything you list/create/edit here lives in `current`. An external Claude Code session picks its workspace with the JUNIOR_WORKSPACE env var (an unknown id silently falls back to the default) — call this to confirm which one you actually landed in.',
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
          browser: z.string().optional().describe(BROWSER_ARG),
          browser_sites: z.array(z.string()).optional().describe(BROWSER_SITES_ARG),
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
          ask: z.enum(ASK_ORDER as [Ask, ...Ask[]]).optional().describe('what it asks of the user (job hits)'),
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
      // Hand-offs (server/handoff-ops.ts): name, description and answer come
      // from the external table entry, so all three doors say the same thing.
      // A write: it prompts like the other junior writes (effects.ts).
      tool(
        HAND_OFF_TOOL.name,
        HAND_OFF_TOOL.description,
        {
          id: z.string().describe(HAND_OFF_TOOL.inputSchema.properties.id.description),
          note: z.string().optional().describe(HAND_OFF_TOOL.inputSchema.properties.note.description),
        },
        async (args) => {
          try {
            const { readiness } = await handoffOp(rt, 'start', { itemId: args.id, ...(args.note ? { note: args.note } : {}) })
            return okResult(handOffAnswer(args.id, readiness))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      // A free read (effects.ts): a dry run of the send policy. It never sends or queues.
      tool(
        CHECK_SEND_TOOL.name,
        CHECK_SEND_TOOL.description,
        {
          tool: z.string().describe(CHECK_SEND_TOOL.inputSchema.properties.tool.description),
          input: z.record(z.string(), z.unknown()).optional().describe(CHECK_SEND_TOOL.inputSchema.properties.input.description),
          cwd: z.string().optional().describe(CHECK_SEND_TOOL.inputSchema.properties.cwd.description),
        },
        async (args) => {
          try {
            return okResult(checkSendAnswer(await checkSendOp(rt, args)))
          } catch (err) {
            return errResult(`rejected: ${errText(err)}`)
          }
        },
      ),
      // Artifacts: files kept beside the inbox (.docs/next-version.md): notes,
      // pages, tables, images. Reads are auto-allowed; writes prompt like
      // every other junior write, and the model may only rewrite its own.
      tool(
        'list_artifacts',
        "List this workspace's artifacts — files kept beside the work items (notes, briefs, pages, tables, images) — with id, title, format, version, author (human|model), refs, path and links. Read one with read_artifact.",
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
        'Read one artifact by id: title, format, version, author, refs, its path on disk, and the full text (markdown without its frontmatter). A pdf or image has no text here: you get the header and the path. Pass version to read an older one.',
        {
          id: z.string().describe('the artifact id from list_artifacts'),
          version: z.number().int().min(1).optional().describe('an older version; omit for the current one'),
        },
        async (args) => {
          try {
            const t = await rt.artifacts.readText(args.id, args.version)
            if (!t) return errResult('no such artifact')
            const a = t.artifact
            const head = [
              `title: ${a.title}`,
              `id: ${a.id}`,
              `format: ${a.format}`,
              `version: ${t.version}${t.latest ? '' : ` (current is v${a.version})`}`,
              `author: ${a.author}`,
              `path: ${t.abs}`,
              a.refs.length ? `refs: ${a.refs.join(', ')}` : undefined,
              t.truncated ? 'note: the text is cut at 2 MB' : undefined,
              t.binary ? 'note: binary file, no text here; open the path' : undefined,
            ].filter((l): l is string => typeof l === 'string')
            return okResult(t.binary ? head.join('\n') : `${head.join('\n')}\n\n${t.text}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'write_artifact',
        'Publish a file as an artifact: a document, page, table, image or other output the user should open. It shows up as a card in this chat, in this session\'s Artifacts and in the Artifacts tab, and every version is kept. Use it for finished work the user will read or share: a report, a chart, a CSV, a PDF. Do not use it for code that belongs in the repo (use Write or Edit; those show under Changes) or for notes to yourself. Text formats (md, html, csv, txt, json, svg): pass title, body and format. Binary or script-made files (pdf, png, jpg, gif, webp, or anything big): make the file, then pass from with its absolute path. To change an artifact you already published, call update_artifact with its id. Never write report-v2.html. Files over 25 MB are refused. Returns JSON with the id and version.',
        {
          title: z.string().describe('a short title'),
          format: z
            .enum(['md', 'html', 'csv', 'txt', 'json', 'svg', 'pdf', 'png', 'jpg', 'gif', 'webp'])
            .optional()
            .describe('md (default), html, csv, txt, json or svg: send them as body. pdf, png, jpg, gif, webp, or any big or script-made file: use from.'),
          body: z.string().optional().describe('the content, for md html csv txt json svg. Up to 2 MB; bigger goes through from.'),
          from: z
            .string()
            .optional()
            .describe('absolute path of a file you made, in the project folder or the temp folder. junior copies it; later edits to the original do not change the artifact.'),
          note: z.string().max(500).optional().describe('one line about this version'),
          refs: z.array(z.string()).optional().describe('GitHub PR/issue URLs or Linear keys this note is about'),
          links: z
            .array(
              z.object({
                kind: z.enum(['item', 'session']),
                id: z.string(),
                role: z.enum(['brief', 'context', 'dispatch', 'output']),
              }),
            )
            .optional()
            .describe('extra links. This session is linked as the output on its own; you do not need to pass it.'),
        },
        async (args) => {
          try {
            return okResult(JSON.stringify(toolResult(await createArtifactOp(rt, args, 'model', { sessionId }))))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'update_artifact',
        'Publish a new version of an artifact you wrote: same id, same card, history kept. Pass the new body (text formats) or from (a file path), and a note: one line on what changed. Use this instead of writing a second artifact such as report-v2.html. The format cannot change; publish a new artifact for that. For non-markdown files, a title or refs change alone does not make a new version. Human-authored artifacts are refused: propose the change in chat.',
        {
          id: z.string(),
          title: z.string().optional(),
          body: z.string().optional(),
          from: z.string().optional().describe('absolute path of a file you made, in the project folder or the temp folder; junior copies it'),
          note: z.string().max(500).optional().describe('one line on what changed in this version'),
          refs: z.array(z.string()).optional(),
        },
        async (args) => {
          try {
            const { id, ...patch } = args
            return okResult(JSON.stringify(toolResult(await updateArtifactOp(rt, id, patch, 'model', { sessionId }))))
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
          role: z.enum(['brief', 'context', 'dispatch', 'output']),
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
      // Advance approvals (core/approvals): the user's OK given before the send.
      tool(
        'list_approvals',
        'The advance approvals the user has given: who + what + when you may send without a card. Live ones only unless all is true.',
        { all: z.boolean().optional().describe('include revoked and expired ones') },
        async (args) => {
          const now = Date.now()
          const list = (await listApprovalsOp(rt)).filter((a) => args.all === true || isLive(a, now))
          return okResult(JSON.stringify(list.map((a) => ({ id: a.id, approves: describeApproval(a), what: a.what, who: a.who, when: a.when, live: isLive(a, now), uses: a.uses })), null, 2))
        },
      ),
      tool(
        'propose_approval',
        'Propose an advance approval: one recipient + one kind of send + when, which the user may add so those sends go out without a card. It shows as a card in this chat; nothing is approved until the user presses Add. Use it when the user says to always let you send something ("you can always DM Anirudha when a PR is ready"), or after they approved the same kind of send several times. Keep it narrow: one person or channel. Look up the Slack user id (slack_search_users) or channel id (slack_search_channels) first. A send you make before they add it still shows its own card.',
        {
          what: z.enum(APPROVAL_WHATS as unknown as [string, ...string[]]).describe('slack-dm: DM one person · slack-post: post in one channel · request-review: ask one GitHub user to review · bot-reply: send the drafted replies to one review bot (who = its login, e.g. coderabbitai)'),
          who: z.object({
            id: z.string().describe('Slack user id (U…), Slack channel id (C…), or GitHub login'),
            name: z.string().describe('what the user reads: "Anirudha", "#eng-reviews"'),
          }),
          when: z
            .object({ playbook: z.string(), step: z.string() })
            .optional()
            .describe('only as one playbook step (e.g. babysit / request reviewer); omit for any time'),
          why: z.string().describe('one line: why this send is safe to make without asking'),
          expiresInDays: z.number().int().min(1).max(365).optional().describe('omit for until revoked'),
        },
        async (args) => {
          const now = Date.now()
          const raw = {
            what: args.what,
            who: args.who,
            when: args.when ? { kind: 'playbook', ...args.when } : { kind: 'any' },
            why: args.why,
            ...(args.expiresInDays ? { expiresAt: now + args.expiresInDays * 86_400_000 } : {}),
          }
          const out = approvalFrom(raw, { id: 'proposal', now, sessionId: sessionId ?? null, proposalId: null })
          if (!out.ok) return errResult(out.error)
          return okResult(
            `Shown to the user as a card: "${describeApproval(out.approval)}". Nothing is approved until they press Add on it. ` +
              'Carry on; a matching send before then still shows its own card.',
          )
        },
      ),
      // Learnings with receipts (core/junior/learnings.ts): Junior proposes, only the user keeps.
      tool(
        'propose_learning',
        'Note something you learned about how the user works, with the receipt that taught you. Only from their own edits, rejections or corrections: they rewrote your diff, turned down a send, or told you to do it another way. Never from your own guesses or from what the code merely shows. The first time it is a quiet note the user never sees. The same words and scope seen again on another day become a proposal, shown as a card the user keeps or undoes. Nothing is kept until they press Keep, and nothing here goes into a prompt until then. One short imperative sentence ("Run pnpm test:unit, not pnpm test, in acme/web").',
        {
          text: z.string().describe('the learning, one short sentence; reuse the exact words when you see it again'),
          scope: z.string().optional().describe('global; repo:<owner>/<repo> when it holds in one repo only; agent:<name> (agent:reviewer) for how one of the user\'s agents should do its job; default global'),
          source: z.string().describe('the receipt: what showed it, e.g. pr:acme/web#3235, slack:<channel>/<ts>, session:<id>, path/to/file.ts:42'),
        },
        async (args) => {
          try {
            return okResult(JSON.stringify(proposeLearningResult(await proposeLearningOp(rt, args))))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      // Pinned notes (core/junior/pins.ts): standing facts and rules the user told Junior. Local, no card.
      tool(
        'pin_note',
        'Pin a fact or rule the user just told you, so it outlives the chat scrolling away and goes into the briefs you write for threads ("Dev is failing: the tenant migration did not run", "Onboarding belongs to another team: don\'t touch it"). One line, in plain words. scope today (default) for a fact about now; always for a standing rule. Say so in one short line after: "Noted. I pinned it for today." Pinning the same words twice keeps one pin.',
        {
          text: z.string().describe('the note, one line'),
          scope: z.enum(['today', 'always']).optional().describe('today (default): true for the rest of the day; always: until the user unpins it'),
        },
        async (args) => {
          try {
            const r = await pinNoteOp(rt, args)
            return okResult(JSON.stringify({ pinned: r.pin, ...(r.existed ? { note: 'already pinned' } : {}) }, null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool('list_pins', 'The pinned notes that hold now, oldest first, each with its id and scope.', {}, async () => {
        try {
          return okResult(JSON.stringify(await listPinsOp(rt), null, 2))
        } catch (err) {
          return errResult(errText(err))
        }
      }),
      // Junior's work log (core/junior/worklog.ts): what the threads it started last reported. A read.
      tool(
        'read_work_log',
        `What the threads you started from your chat last reported, one dated line each, newest first. Use it for "what did you do yesterday" or to find an older thread by its title. It keeps ${WORKLOG_KEEP_DAYS} days.`,
        { days: z.number().int().min(1).max(WORKLOG_KEEP_DAYS).optional().describe('how far back, in days (default 7)') },
        async (args) => {
          try {
            const now = Date.now()
            const lines = recentWork(await worklogFor(rt, now), now, args.days ?? 7, 200).map(worklogLine)
            return okResult(lines.length ? lines.join('\n') : 'Nothing in the work log for that window.')
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      // Junior's memory (core/junior/memory.ts): facts it keeps on its own in memory.md. Local, no card.
      tool(
        'remember',
        `Keep a fact in your memory, which every chat and thread you start reads: who someone is, what a project or service is, where a long piece of work stands, a decision and why. One plain line. To update a line, pass \`replaces\` with some of its text. Not for how the user wants work done (propose_learning), facts true only today or rules they state (pin_note), or secrets. The file holds ${MEMORY_MAX_BYTES} bytes; the oldest lines move to an archive when it is full.`,
        {
          text: z.string().describe('the fact, one line'),
          replaces: z.string().optional().describe('some text of the one line this replaces'),
        },
        async (args) => {
          try {
            const r = await rememberOp(rt, args)
            const notes = [r.existed ? 'already kept' : '', r.replaced ? `replaced: ${r.replaced.text}` : '', r.archived.length ? `${r.archived.length} oldest line${r.archived.length === 1 ? '' : 's'} moved to memory-archive.md` : ''].filter(Boolean)
            return okResult(`ok: remembered${notes.length ? ` (${notes.join('; ')})` : ''}`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'forget',
        'Drop one line from your memory, by some of its text. Use it when the user says a fact is wrong or no longer holds, or when you find it is.',
        { text: z.string().describe('some text of the one line to drop') },
        async (args) => {
          try {
            const gone = await forgetOp(rt, args.text)
            return okResult(`ok: forgot "${gone.text}"`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool('read_memory', 'Your memory as it is now, oldest line first. Your prompt has it as of when this chat started.', {}, async () => {
        try {
          const lines = await memoryForPrompt(rt)
          return okResult(lines.length ? lines.map(memoryLine).join('\n') : 'Your memory is empty.')
        } catch (err) {
          return errResult(errText(err))
        }
      }),
      tool(
        'unpin',
        'Take a pinned note off, by its id (list_pins shows ids). Use it when the user says a pinned fact no longer holds.',
        { id: z.string().describe('the pin\'s id, p-…') },
        async (args) => {
          try {
            const pin = await unpinOp(rt, args.id)
            return okResult(`ok: unpinned "${pin.text}"`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      // Chats that start chats (server/session/spawn-ops.ts): each one an ordinary chat in the list,
      // addressed by its name (the handle `/rename` sets). Local work, so no card.
      tool(
        'start_session',
        'Start new chat sessions, one per task, each opened with its prompt as a message from this chat. This is how you hand a task to one of the user\'s agents: give `agent` (Reviewer, Babysitter, …) and the session is a thread that talks as that agent, with its instructions and memory. Without `agent` it is plain Junior. Use it too when the user hands you several things to do in parallel ("start 3 sessions: one for X, one for Y…"). Each is a normal chat the user can open and type into. Give each a short unique name (what /rename sets); you address it by that name later with message_session and read_session. A session runs in this chat\'s folder unless you give it a worktree branch, which keeps parallel edits apart. Write each prompt as a full hand-off: the session starts with none of this chat\'s context.',
        {
          sessions: z
            .array(
              z.object({
                name: z.string().describe('short handle, unique in the workspace, e.g. "auth fix"'),
                title: z.string().optional().describe('what the chat list shows; default = the name'),
                prompt: z.string().describe('the first message: the task, with every bit of context it needs'),
                mode: z.enum(['normal', 'plan']).optional().describe('plan: it plans and waits for the user to approve before editing'),
                worktree: z.string().optional().describe('a branch name: run in a new worktree on that branch instead of this folder'),
                agent: z.string().optional().describe('the agent this thread talks as: its label (Reviewer), file name or full name; omit for plain Junior'),
                attachments: ATTACHMENTS_ARG,
              }),
            )
            .min(1)
            .max(6),
        },
        async (args) => {
          if (!sessionId) return errResult('start_session needs a chat session')
          try {
            const started = await startSessionsOp(rt, sessionId, args.sessions)
            return okResult(JSON.stringify({ started, next: 'message_session to follow up, read_session or list_sessions to see where they stand' }, null, 2))
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'message_session',
        'Send a message to another chat session by its name, as this chat (it shows "from" this chat, never as the user). A session that has stopped is started again. It does not wait for the answer: read it later with read_session.',
        {
          name: z.string().describe('the session\'s name'),
          text: z.string().describe('the message'),
          attachments: ATTACHMENTS_ARG,
        },
        async (args) => {
          if (!sessionId) return errResult('message_session needs a chat session')
          try {
            const target = await messageSessionOp(rt, sessionId, args.name, args.text, args.attachments)
            return okResult(`ok: sent to "${target.name}"`)
          } catch (err) {
            return errResult(errText(err))
          }
        },
      ),
      tool(
        'read_session',
        'Where a chat session stands, by its name: working, waiting on the user, idle or error, and the last thing it said.',
        { name: z.string().describe('the session\'s name') },
        async (args) => {
          const row = sessionByName(rt, args.name)
          if (!row) return errResult(`no session is named "${args.name}"`)
          return okResult(JSON.stringify(await sessionReport(rt, row, true), null, 2))
        },
      ),
      tool(
        'list_sessions',
        'The chat sessions this chat started, newest first, each with its name and state. Pass all to list every named session in the workspace instead.',
        { all: z.boolean().optional().describe('every named session, not only the ones this chat started') },
        async (args) => {
          const rows = args.all === true ? [...rt.rows.values()].filter((r) => r.name && r.kind === 'chat') : sessionId ? startedBy(rt, sessionId) : []
          return okResult(JSON.stringify(await Promise.all(rows.map((r) => sessionReport(rt, r, false))), null, 2))
        },
      ),
    ],
  })
}

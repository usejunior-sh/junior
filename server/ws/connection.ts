import path from 'node:path'
import { chatPermissionMode } from '../../core/actions/policy.js'
import http from 'node:http'
import { WebSocket } from 'ws'
import { accessOf } from '../remote.js'
import { isConnected } from '../workspaces.js'
import { providerFor } from '../providers/registry.js'
import { claimSessionFiles, resolveUploads } from '../attachments.js'
import { type FileRef, MAX_FILES_PER_MESSAGE, MAX_IMAGES_PER_MESSAGE } from '../../shared/protocol.js'
import { itemImageAttachments } from '../itemImages.js'
import { log } from '../log.js'
import { BUILD, PORT } from '../config.js'
import { resolveRuntime } from '../routes/http-util.js'
import { remote, remoteWs } from '../phone.js'
import { broadcastSessionList, send } from './send.js'
import { summaries, summarize } from '../session/summaries.js'
import { wireWorkspaces } from '../workspace/wiring.js'
import { registry } from '../workspace/runtime.js'
import { checkoutList, mainCheckout, makeWorktree } from '../session/checkouts.js'
import { parseClientMessage } from './parse.js'
import { replaySession } from './history.js'
import { renameCommand } from '../../core/sessions/names.js'
import { setSessionNameOp } from '../session/spawn-ops.js'
import { createSession, defaultProject, deleteSession, getOrRevive, projectForSession } from '../session/sessions.js'
import { expandHome } from '../folders.js'
import { linkSessionToItem } from '../settings-ops.js'
import { itemFilesForSession } from '../items-ops.js'
import { sessionNotice } from '../team-run/state.js'
import { errText } from '../errors.js'
import { checkModelChoice } from '../workspace/probes.js'

export function handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
  const url = new URL(req.url ?? '/ws', `http://localhost:${PORT}`)
  const rt = resolveRuntime(req, url)
  rt.clients.add(ws)
  if (accessOf(req, remote) !== 'local') {
    remoteWs.add(ws)
    ws.on('close', () => remoteWs.delete(ws))
  }
  send(ws, {
    type: 'hello',
    sessions: summaries(rt),
    workspaceId: rt.meta.id,
    workspaces: wireWorkspaces(),
    onboarded: registry.onboarded,
    terminals: rt.terminals.list(),
    checkouts: checkoutList(rt),
    build: BUILD,
    persona: rt.persona,
  })

  ws.on('message', async (raw) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(String(raw))
    } catch {
      return
    }
    const msg = parseClientMessage(parsed)
    if (!msg) return

    try {
      switch (msg.type) {
        case 'create_session': {
          if (msg.provider && !isConnected(rt.meta, msg.provider))
            throw new Error(`${providerFor(msg.provider).label} isn't connected in this workspace — connect it in Settings → Providers`)
          // Named uploads must still be there. Checked first, before a worktree or a session exists, so a stale one creates nothing.
          if (msg.files) await resolveUploads(rt.attachmentsDir, msg.files, MAX_FILES_PER_MESSAGE)
          // A checkout names both the folder and the project; it must still be there.
          let checkout = msg.checkoutId ? rt.checkouts.get(msg.checkoutId) : undefined
          if (msg.checkoutId && checkout?.state !== 'active') throw new Error('that checkout is gone — pick another folder')
          // A new worktree is made before the session exists, so the session's folder is the worktree.
          if (!checkout && msg.worktree?.branch) {
            const target = msg.projectId
              ? (await rt.store.projects.list()).find((p) => p.id === msg.projectId)
              : await projectForSession(rt, expandHome(msg.cwd || (await defaultProject(rt))?.path || '~'))
            if (!target) throw new Error('unknown project')
            checkout = await makeWorktree(rt, target, msg.worktree.branch, msg.itemId, (step) => send(ws, { type: 'create_progress', step }))
            send(ws, { type: 'create_progress', step: 'session' })
          }
          const fallback = msg.cwd || checkout ? null : await defaultProject(rt)
          const cwd = checkout?.path ?? expandHome(msg.cwd || fallback?.path || '~')
          const project = await projectForSession(rt, cwd, checkout?.projectId ?? msg.projectId ?? fallback?.id)
          const title = msg.title.trim() || `Session ${rt.rows.size + 1}`
          const row = await createSession(
            rt,
            title,
            msg.cwd || checkout ? cwd : project.path,
            msg.model ?? null,
            msg.effort ?? null,
            msg.fastMode === true,
            // One policy (core/actions/policy.ts): no level to pick.
            chatPermissionMode(msg.provider),
            // Plan mode and Ultracode are Claude's; another agent starts normally.
            {
              projectId: project.id,
              checkoutId: checkout?.id,
              provider: msg.provider,
              planning: msg.mode === 'plan' && (msg.provider ?? 'claude') === 'claude',
              ultracode: msg.mode === 'ultracode' && (msg.provider ?? 'claude') === 'claude',
            },
          )
          // Dispatched from an item: the link is what the item page shows as "sessions".
          if (msg.itemId) await linkSessionToItem(rt, row.id, msg.itemId, 'dispatch').catch(() => {})
          send(ws, { type: 'session_created', session: summarize(rt, row) })
          broadcastSessionList(rt)
          // A dispatch opens with the item's screenshots attached, the draft
          // composer never carries the bytes, the server reads them off disk.
          const dispatched = msg.itemId ? await rt.store.items.get(msg.itemId).catch(() => null) : null
          const fromItem = dispatched
            ? await itemImageAttachments(rt.attachmentsDir, dispatched.id, dispatched.images)
            : undefined
          const images = [...(fromItem ?? []), ...(msg.images ?? [])].slice(0, MAX_IMAGES_PER_MESSAGE)
          // The item's files are copied into this session's folder, so it reads its own copy by path.
          const itemFiles = dispatched ? await itemFilesForSession(rt, row.id, dispatched) : { files: [], note: null }
          // The session exists by now; if an upload vanished since the check above, say so in it instead of leaving it silent.
          let files: FileRef[] = itemFiles.files
          try {
            if (msg.files?.length) files = [...files, ...(await claimSessionFiles(rt.attachmentsDir, row.id, msg.files, MAX_FILES_PER_MESSAGE))]
          } catch (err) {
            await sessionNotice(rt, row.id, `Not sent: ${errText(err)}`)
            break
          }
          const firstMessage = [msg.firstMessage?.trim(), itemFiles.note].filter(Boolean).join('\n\n')
          if (firstMessage || images.length || files.length || msg.mentions?.length)
            void rt.live
              .get(row.id)
              ?.sendUserMessage(firstMessage, images.length ? images : undefined, msg.mentions, {
                ...(msg.mode === 'goal' ? { mode: 'goal' as const } : {}),
                ...(files.length ? { files } : {}),
              })
          break
        }
        case 'set_model': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          const choice = await checkModelChoice(rt, row.provider, msg.model ?? null, msg.effort ?? null).catch((err) => {
            log('warn', 'models', `could not check ${row.provider} models: ${errText(err)}`, { workspace: rt.meta.id, session: row.id })
            return null
          })
          if (!choice) {
            log('warn', 'models', `refused ${row.provider} model ${msg.model}`, { workspace: rt.meta.id, session: row.id })
            broadcastSessionList(rt) // puts the picker back on the stored choice
            break
          }
          row.model = choice.model
          row.effort = choice.effort
          await rt.store.sessions.setModel(row.id, row.model, row.effort)
          // A session with no subprocess picks the choice up from its row when
          // it is revived; a live one is switched in place.
          await rt.live.get(row.id)?.setModel(row.model, row.effort)
          broadcastSessionList(rt)
          break
        }
        case 'set_fast_mode': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          row.fastMode = msg.fastMode
          await rt.store.sessions.setFastMode(row.id, row.fastMode)
          // Same shape as set_model: the row is what a revival reads, and a
          // live subprocess is switched in place.
          await rt.live.get(row.id)?.setFastMode(row.fastMode)
          broadcastSessionList(rt)
          break
        }
        case 'set_session_mode': {
          const row = rt.rows.get(msg.sessionId)
          if (!row || row.provider !== 'claude' || row.kind !== 'chat') break
          const planning = msg.mode === 'plan'
          if (row.planning === planning) break
          row.planning = planning
          await rt.store.sessions.setPlanning(row.id, planning)
          const session = rt.live.get(row.id)
          if (session && !(await session.setPlanning(planning))) session.stop()
          if (session) session.notice(planning ? 'Plan mode — Junior reads and writes a plan, and edits nothing until you approve it.' : 'Plan mode off.')
          broadcastSessionList(rt)
          break
        }
        case 'set_ultracode': {
          const row = rt.rows.get(msg.sessionId)
          if (!row || row.provider !== 'claude' || row.kind !== 'chat' || row.ultracode === msg.on) break
          row.ultracode = msg.on
          await rt.store.sessions.setUltracode(row.id, msg.on)
          // Switched in place, so runs already going carry on; a subprocess that can't is revived with the new row.
          const session = rt.live.get(row.id)
          const revived = !!session && !(await session.setUltracode(msg.on))
          if (session && revived) session.stop()
          await sessionNotice(rt, row.id, msg.on ? 'Ultracode on.' : revived ? 'Ultracode off.' : 'Ultracode off. Runs already going carry on.')
          broadcastSessionList(rt)
          break
        }
        case 'rename_session': {
          const row = rt.rows.get(msg.sessionId)
          const title = msg.title.trim()
          // An empty title would leave a nameless row in the sidebar; the old
          // one stays instead.
          if (!row || !title) break
          row.title = title
          await rt.store.sessions.rename(row.id, title)
          broadcastSessionList(rt)
          break
        }
        case 'set_pinned': {
          const row = rt.rows.get(msg.sessionId)
          if (!row) break
          row.pinned = msg.pinned
          await rt.store.sessions.setPinned(row.id, msg.pinned)
          broadcastSessionList(rt)
          break
        }
        case 'delete_session': {
          if (!rt.rows.has(msg.sessionId)) break
          await deleteSession(rt, msg.sessionId)
          break
        }
        case 'subscribe':
        case 'session_events_before': {
          await replaySession(rt, ws, msg)
          break
        }
        case 'user_message': {
          if (!msg.text.trim() && !msg.images?.length && !msg.files?.length && !msg.mentions?.length) break
          // `/rename <name>`: the session's handle, here and in Claude Code. Junior's to keep, so other
          // chats can address it (message_session); the command never reaches the model.
          const renamed = renameCommand(msg.text)
          if (renamed !== null && rt.rows.has(msg.sessionId)) {
            const r = await setSessionNameOp(rt, msg.sessionId, renamed).catch((err: unknown) => err)
            await sessionNotice(rt, msg.sessionId, r instanceof Error ? `Not renamed: ${r.message}` : r ? `Named this session "${r}".` : 'Cleared this session\'s name.')
            break
          }
          // A session the retired goals engine started has no engine to go back to.
          if (rt.rows.get(msg.sessionId)?.kind === 'goal') {
            await sessionNotice(rt, msg.sessionId, 'Not sent. This session ran under the old goals engine, which is retired. Ask Junior in a new chat.')
            break
          }
          const session = await getOrRevive(rt, msg.sessionId)
          let files: FileRef[] = []
          if (session && msg.files?.length) {
            try {
              files = await claimSessionFiles(rt.attachmentsDir, msg.sessionId, msg.files, MAX_FILES_PER_MESSAGE)
            } catch (err) {
              await sessionNotice(rt, msg.sessionId, `Not sent: ${errText(err)}`)
              break
            }
          }
          void session?.sendUserMessage(msg.text.trim(), msg.images, msg.mentions, {
            ...(msg.mode ? { mode: msg.mode } : {}),
            ...(files.length ? { files } : {}),
          })
          break
        }
        case 'permission_response': {
          rt.live.get(msg.sessionId)?.resolvePermission(msg.requestId, msg.behavior, msg.answers)
          break
        }
        case 'interrupt': {
          void rt.live.get(msg.sessionId)?.interrupt()
          break
        }
        // A subagent only runs inside a live subprocess: with none, there is nothing to stop or background.
        case 'agent_stop': {
          void rt.live.get(msg.sessionId)?.stopAgent(msg.agentId)
          break
        }
        case 'agent_background': {
          void rt.live.get(msg.sessionId)?.backgroundAgent(msg.toolUseId)
          break
        }
        case 'agent_message': {
          // A finished agent can still be written to: main resumes it, so revive main if needed.
          const session = await getOrRevive(rt, msg.sessionId)
          void session?.sendAgentMessage(msg.relay, msg.text)
          break
        }
        case 'terminal_create': {
          const checkout = msg.checkoutId ? rt.checkouts.get(msg.checkoutId) : undefined
          const cwd = checkout?.path ?? (msg.cwd ? path.resolve(expandHome(msg.cwd)) : undefined)
          const projects = await rt.store.projects.list()
          const project =
            (checkout ? projects.find((p) => p.id === checkout.projectId) : undefined) ??
            (msg.projectId ? projects.find((p) => p.id === msg.projectId) : undefined) ??
            (cwd ? projects.find((p) => path.resolve(p.path) === cwd) : undefined) ??
            projects.find((p) => p.isDefault)
          const terminal = rt.terminals.create({
            cwd: cwd ?? project?.path,
            projectId: project?.id ?? null,
            checkoutId: checkout?.id ?? mainCheckout(rt, project?.id)?.id ?? null,
            title: msg.title,
            command: msg.command,
            env: rt.env,
          })
          // The creator hears first so it can switch to the new tab; the list
          // broadcast (already sent by the manager) brings everyone else along.
          send(ws, { type: 'terminal_created', terminal })
          break
        }
        case 'terminal_input': {
          rt.terminals.write(msg.terminalId, msg.data)
          break
        }
        case 'terminal_resize': {
          rt.terminals.resize(msg.terminalId, msg.cols, msg.rows)
          break
        }
        case 'terminal_subscribe': {
          if (rt.terminals.get(msg.terminalId)) {
            send(ws, { type: 'terminal_history', terminalId: msg.terminalId, data: rt.terminals.history(msg.terminalId) })
          }
          break
        }
        case 'terminal_rename': {
          rt.terminals.rename(msg.terminalId, msg.title)
          break
        }
        case 'terminal_close': {
          rt.terminals.close(msg.terminalId)
          break
        }
      }
    } catch (err) {
      // A draft waiting on its session must hear why it didn't come, not just the console.
      if (msg.type === 'create_session') send(ws, { type: 'create_failed', message: errText(err) })
      else send(ws, { type: 'error', message: String(err) })
    }
  })

  ws.on('close', () => rt.clients.delete(ws))
}

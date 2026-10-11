// Live check of the Codex provider, no server needed: open a session in a temp
// git repo, run a turn that edits a file and runs a command (both approved
// through `approve`, as the permission prompt would), then resume the thread in
// a fresh subprocess and ask about the first turn. Needs `codex` logged in.
//
//   npx tsx scripts/codex-live.ts
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codex } from '../server/providers/codex.js'
import type { ToolApproval, UserTurn } from '../server/providers/types.js'

const timer = setTimeout(() => {
  console.log('TIMEOUT')
  process.exit(2)
}, 240_000)

const cwd = mkdtempSync(path.join(os.tmpdir(), 'triage-codex-'))
execSync('git init -q && echo "hello" > a.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm init', { cwd })

const asked: string[] = []
const approve: ToolApproval = async (toolName, input) => {
  asked.push(`${toolName} ${JSON.stringify(input)}`)
  return { behavior: 'allow', updatedInput: input }
}

/** One session, one turn: the events it printed and the result's text. */
async function turn(text: string, resume?: string) {
  let send!: (t: UserTurn) => void
  let close!: () => void
  const sent = new Promise<UserTurn>((res) => (send = res))
  const closed = new Promise<void>((res) => (close = res))
  async function* input(): AsyncGenerator<UserTurn> {
    yield await sent
    await closed
  }
  const session = codex.openSession(input(), { cwd, mcpServers: {}, approve, ...(resume ? { resume } : {}) })
  let threadId = ''
  let reply = ''
  for await (const ev of session) {
    if (ev.kind === 'started') {
      threadId = ev.sessionId ?? ''
      console.log(`started thread=${threadId} model=${ev.model}`)
      send({ content: [{ type: 'text', text }] })
    } else if (ev.kind === 'message') {
      const tools = ev.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.input).slice(0, 80)})`).join(' ')
      console.log(`message ${ev.role}${tools ? ` ${tools}` : ''}`)
    } else if (ev.kind === 'result') {
      console.log(`result ok=${ev.ok} tokens=${ev.tokens} text=${JSON.stringify(ev.text)}`)
      reply = ev.text
      close()
    }
  }
  return { threadId, reply }
}

const first = await turn('Append the line "world" to a.txt, then run `cat a.txt`. Reply with only the output of cat.')
console.log('approvals asked:', asked)
console.log('a.txt now:', JSON.stringify(readFileSync(path.join(cwd, 'a.txt'), 'utf8')))
const second = await turn('Which file did you change in the previous turn? Reply with only its name.', first.threadId)

clearTimeout(timer)
const ok = !!first.reply && second.threadId === first.threadId && /a\.txt/.test(second.reply)
console.log(ok ? 'OK' : 'FAIL')
process.exit(ok ? 0 : 1)

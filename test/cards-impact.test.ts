/**
 * The impact line on a held send (core/cards/impact.ts): what it does, who
 * sees it, as whom, and whether it can be taken back. One row per kind of
 * send; numbers only when the args or the caller's facts give them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { impactLine, impactOf, serverName, type ImpactFacts, type ImpactInput } from '../core/cards/impact.js'

type Row = { name: string; action: ImpactInput; facts?: ImpactFacts; line: string }

const bash = (command: string, extra: Partial<ImpactInput> = {}): ImpactInput => ({ tool: 'Bash', args: { command }, ...extra })
const SLACK = 'mcp__claude_ai_Slack__slack_send_message'

const ROWS: Row[] = [
  // Push
  { name: 'push a named branch', action: bash('git push origin feat/x'), line: 'Push feat/x to origin · as you · undo needs a force-push' },
  { name: 'push HEAD, current branch known', action: bash('git push -u origin HEAD'), facts: { currentBranch: 'feat/y' }, line: 'Push feat/y to origin · as you · undo needs a force-push' },
  { name: 'push the current branch by substitution', action: bash('git push -u origin "$(git branch --show-current)"'), facts: { currentBranch: 'feat/z' }, line: 'Push feat/z to origin · as you · undo needs a force-push' },
  { name: 'push with no refspec, branch from the group key', action: bash('git push', { groupKey: 'push:s1:feat/k' }), line: 'Push feat/k · as you · undo needs a force-push' },
  { name: 'push a variable: never shown as a value', action: bash('git push origin $B'), line: 'Push a branch to origin · as you · undo needs a force-push' },
  { name: 'force-push', action: bash('git push --force-with-lease origin HEAD:feat/x'), line: 'Force-push feat/x to origin · as you · overwrites the remote branch' },
  { name: 'push to the default branch says so', action: bash('git push origin main'), facts: { defaultBranch: 'main' }, line: 'Push main to origin · the default branch · as you · undo needs a force-push' },

  // PR
  { name: 'gh pr create, reviewers named in the command', action: bash('gh pr create --title "Fix it" -B main -r alice,bob --reviewer carol', { kind: 'pr' }), facts: { repo: 'acme/api' }, line: 'Open a PR in acme/api into main · asks 3 reviewers · as you · can close, not delete' },
  { name: 'gh pr create, draft, no reviewers known', action: bash('gh pr create --draft --title x'), line: 'Open a draft PR · as you · can close, not delete' },
  { name: 'gh pr create, reviewers estimated by the caller', action: bash('gh pr create -t x'), facts: { reviewers: { n: 2, estimated: true } }, line: 'Open a PR · about 2 reviewers · as you · can close, not delete' },
  { name: 'GitHub MCP create_pull_request', action: { tool: 'mcp__github__create_pull_request', args: { owner: 'acme', repo: 'api', base: 'main', head: 'feat/x', title: 'x' } }, line: 'Open a PR in acme/api into main · as you · can close, not delete' },

  // Comment
  { name: 'gh pr comment with -R', action: bash('gh pr comment 3235 -R acme/api --body "Fixed."'), line: 'Comment on acme/api#3235 · as you · can edit or delete, not unsend' },
  { name: 'gh pr comment with a URL', action: bash('gh pr comment https://github.com/acme/web/pull/12 -b ok'), line: 'Comment on acme/web#12 · as you · can edit or delete, not unsend' },
  { name: 'gh issue comment, no repo known', action: bash('gh issue comment 14 --body hi'), line: 'Comment on issue #14 · as you · can edit or delete, not unsend' },
  { name: 'GitHub MCP add_issue_comment', action: { tool: 'mcp__github__add_issue_comment', args: { owner: 'acme', repo: 'api', issue_number: 3235, body: 'x' } }, line: 'Comment on acme/api#3235 · as you · can edit or delete, not unsend' },
  { name: 'Linear comment', action: { tool: 'mcp__claude_ai_Linear__create_comment', args: { issueId: 'ENG-12', body: 'x' } }, line: 'Comment on ENG-12 · as you · can edit or delete, not unsend' },

  // Review
  { name: 'gh pr review --approve', action: bash('gh pr review 3235 --approve -R acme/api'), line: "Approve acme/api#3235 · as you · can't be deleted, only dismissed" },
  { name: 'gh pr review -r (request changes)', action: bash('gh pr review 7 -r -b "see notes"'), facts: { repo: 'acme/api' }, line: "Request changes on acme/api#7 · as you · can't be deleted, only dismissed" },
  { name: 'GitHub MCP review, comment event', action: { tool: 'mcp__github__create_pull_request_review', args: { owner: 'acme', repo: 'api', pull_number: 9, event: 'COMMENT', body: 'x' } }, line: "Review acme/api#9 · as you · can't be deleted, only dismissed" },

  // Slack post / DM
  { name: 'Slack post, channel name known, members known', action: { tool: SLACK, args: { channel_id: 'C0123ABCD', message: 'hi' } }, facts: { channelName: 'payments', members: { n: 41 } }, line: 'Post in #payments · 41 members · as you · can edit or delete, not unsend' },
  { name: 'Slack post, members estimated', action: { tool: SLACK, args: { channel: 'payments', message: 'hi' } }, facts: { members: { n: 40, estimated: true } }, line: 'Post in #payments · about 40 members · as you · can edit or delete, not unsend' },
  { name: 'Slack post, only an id, no count', action: { tool: SLACK, args: { channel_id: 'C0123ABCD', message: 'hi' } }, line: 'Post in C0123ABCD · as you · can edit or delete, not unsend' },
  { name: 'Slack thread reply, broadcast', action: { tool: SLACK, args: { channel_id: 'C0123ABCD', thread_ts: '1.2', reply_broadcast: true, message: 'x' } }, facts: { channelName: 'eng' }, line: 'Reply in a thread in #eng · also in channel · as you · can edit or delete, not unsend' },
  { name: 'Slack DM, person known', action: { tool: SLACK, args: { channel_id: 'D0123ABCD', message: 'hi' } }, facts: { channelName: 'priya', members: { n: 2 } }, line: 'Send a DM to @priya · as you · can edit or delete, not unsend' },
  { name: 'Slack DM to a user id', action: { tool: SLACK, args: { channel_id: 'U0123ABCD', message: 'hi' } }, line: 'Send a DM · as you · can edit or delete, not unsend' },
  { name: 'Slack scheduled post', action: { tool: 'mcp__claude_ai_Slack__slack_schedule_message', args: { channel_id: 'C0123ABCD', message: 'x', post_at: 1 } }, facts: { channelName: 'eng' }, line: 'Schedule a post in #eng · as you · can cancel before it sends' },
  { name: 'Slack draft', action: { tool: 'mcp__claude_ai_Slack__slack_send_message_draft', args: { channel_id: 'C0123ABCD', message: 'x' } }, facts: { channelName: 'eng' }, line: 'Save a Slack draft for #eng · as you · nobody sees it yet' },

  // Ticket move / update / create
  { name: 'Linear move to a state', action: { tool: 'mcp__claude_ai_Linear__update_issue', args: { id: 'ENG-12', state: 'Done' } }, line: 'Move ENG-12 to Done · as you · can change back' },
  { name: 'Jira transition', action: { tool: 'mcp__atlassian__transitionJiraIssue', args: { issueIdOrKey: 'PX-197', transition: { id: '31', name: 'In Review' } } }, line: 'Move PX-197 to In Review · as you · can change back' },
  { name: 'gh issue close', action: bash('gh issue close 12 -R acme/api'), line: 'Close acme/api#12 · as you · can reopen' },
  { name: 'Linear create issue', action: { tool: 'mcp__claude_ai_Linear__create_issue', args: { team: 'ENG', title: 'x' } }, line: 'New issue in ENG · as you · can close' },
  { name: 'gh issue create', action: bash('gh issue create -t x -R acme/api'), line: 'New issue in acme/api · as you · can close' },

  // Merge, release, email
  { name: 'gh pr merge', action: bash('gh pr merge 5 --squash -R acme/api'), line: 'Merge acme/api#5 · as you · undo needs a revert' },
  { name: 'gh release create', action: bash('gh release create v1.2.0 --notes x'), line: 'Publish release v1.2.0 · as you · hard to take back' },
  { name: 'email to three people', action: { tool: 'mcp__claude_ai_Gmail__send_email', args: { to: ['a@x.com', 'b@x.com'], cc: 'c@x.com', subject: 's', body: 'b' } }, line: "Email a@x.com +2 · 3 recipients · as you · can't be unsent" },

  // Unknown
  { name: 'unknown MCP write: generic and honest', action: { tool: 'mcp__claude_ai_Notion__notion-create-pages', args: { pages: [] } }, line: 'Sends through Notion · as you' },
  { name: 'unknown MCP server, raw name', action: { tool: 'mcp__acme-deployer__trigger', args: {} }, line: 'Sends through acme deployer · as you' },
  { name: 'an update tool that isn’t about issues stays generic', action: { tool: 'mcp__acme__update_permissions', args: { id: 'u1', role: 'admin' } }, line: 'Sends through acme · as you' },
  { name: 'gh api POST', action: bash('gh api -X POST repos/acme/api/dispatches -f event_type=x'), line: 'Call the GitHub API · POST repos/acme/api/dispatches · as you' },
  { name: 'an unknown shell command: no claim about where', action: bash('$G push'), line: 'Run `$G push` · as you' },
  { name: 'two sends in one command: the headline, and the rest counted', action: bash('git push origin feat/x && gh pr create -t x'), line: 'Open a PR · +1 more send · as you · can close, not delete' },
  { name: 'who it goes out as, when the caller knows', action: { tool: SLACK, args: { channel: 'ops', message: 'x' } }, facts: { as: 'the deploy bot' }, line: 'Post in #ops · as the deploy bot · can edit or delete, not unsend' },
]

for (const r of ROWS) {
  test(`impact: ${r.name}`, () => {
    assert.equal(impactLine(r.action, r.facts), r.line)
  })
}

test('no numbers unless the args or the facts give them', () => {
  for (const r of ROWS) {
    if (r.facts?.members || r.facts?.reviewers) continue
    const line = impactLine(r.action, r.facts)
    // Digits only from the args themselves (refs, tags, recipients listed), never a made-up count.
    const counts = line.match(/\b\d+ (?:members?|reviewers?)\b/g)
    if (counts) assert.match(String(r.action.args.command ?? ''), /-r|--reviewer/, `${r.name}: ${line}`)
  }
})

test('a count that isn’t a whole number is left out, not shown', () => {
  const a: ImpactInput = { tool: SLACK, args: { channel: 'eng', message: 'x' } }
  assert.equal(impactOf(a, { members: { n: Number.NaN } }).reach, null)
  assert.equal(impactOf(a, { members: { n: -1 } }).reach, null)
  assert.equal(impactOf(a, { members: { n: 2.5 } }).reach, null)
  assert.equal(impactOf(a, { members: { n: 1 } }).reach, '1 member')
})

test('every line names who it goes out as', () => {
  for (const r of ROWS) assert.match(impactLine(r.action, r.facts), / · as /)
})

test('server names read the way a person says them', () => {
  assert.equal(serverName('mcp__claude_ai_Slack__x'), 'Slack')
  assert.equal(serverName('mcp__plugin_linear_linear__x'), 'Linear')
  assert.equal(serverName('mcp__github__x'), 'GitHub')
  assert.equal(serverName('mcp__my_server__x'), 'my server')
})

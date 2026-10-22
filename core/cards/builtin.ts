/**
 * The card specs junior ships (./spec.ts). A workspace's `cards/<id>.json`
 * for the same tool wins over these. Arg names are the connectors' own; a
 * name a tool doesn't send just leaves its slot empty, and every arg the
 * spec doesn't place still shows, under "All fields".
 *
 * Pure and browser-safe.
 */
import type { CardSpec } from './spec.js'

const SLACK_LABELS = { channel_id: 'channel', thread_ts: 'thread', reply_broadcast: 'also in channel', unfurl_app_links: 'link previews', post_at: 'send at' }
const SLACK_MESSAGE = { target: ['channel_id', 'thread_ts'], body: 'message', edit: { message: 'markdown' as const }, labels: SLACK_LABELS }

const MAIL = { target: ['to', 'cc', 'bcc'], subject: 'subject', body: 'body' }

const LINEAR_CHIPS = ['state', 'priority', 'labels', 'assignee', 'dueDate']

const GITHUB_LABELS = { issue_number: 'issue', pull_number: 'PR' }

export const BUILTIN_SPECS: readonly CardSpec[] = [
  // Slack
  { id: 'slack.send_message', tool: 'mcp__*__slack_send_message', layout: 'message', kind: 'message', name: 'Slack', verb: 'Send', ...SLACK_MESSAGE },
  { id: 'slack.schedule_message', tool: 'mcp__*__slack_schedule_message', layout: 'message', kind: 'message', name: 'Slack', verb: 'Schedule', ...SLACK_MESSAGE, chips: ['post_at'] },
  { id: 'slack.send_message_draft', tool: 'mcp__*__slack_send_message_draft', layout: 'message', kind: 'post', name: 'Slack', verb: 'Save draft', ...SLACK_MESSAGE },

  // Email
  { id: 'gmail.send_email', tool: 'mcp__*gmail*__send_email', layout: 'email', kind: 'email', name: 'Gmail', verb: 'Send', ...MAIL },
  { id: 'gmail.create_draft', tool: 'mcp__*gmail*__create_draft', layout: 'email', kind: 'post', name: 'Gmail', verb: 'Save draft', ...MAIL },

  // Linear
  {
    id: 'linear.create_issue',
    tool: 'mcp__*linear*__create_issue',
    layout: 'ticket',
    kind: 'ticket',
    name: 'Linear',
    verb: 'Create',
    title: 'New issue · {title}',
    target: ['team', 'project', 'parentId'],
    chips: LINEAR_CHIPS,
    subject: 'title',
    body: 'description',
    edit: { description: 'markdown' },
    labels: { parentId: 'parent', dueDate: 'due' },
  },
  {
    id: 'linear.update_issue',
    tool: 'mcp__*linear*__update_issue',
    layout: 'ticket',
    kind: 'update',
    name: 'Linear',
    verb: 'Update',
    title: 'Update {id}',
    target: ['id', 'team', 'project'],
    chips: LINEAR_CHIPS,
    subject: 'title',
    body: 'description',
    edit: { description: 'markdown' },
    labels: { id: 'issue', dueDate: 'due' },
  },
  { id: 'linear.create_comment', tool: 'mcp__*linear*__create_comment', layout: 'message', kind: 'comment', name: 'Linear', verb: 'Comment', target: ['issueId'], body: 'body', edit: { body: 'markdown' }, labels: { issueId: 'issue' } },

  // Jira
  {
    id: 'jira.create_issue',
    tool: 'mcp__*__createJiraIssue',
    layout: 'ticket',
    kind: 'ticket',
    name: 'Jira',
    verb: 'Create',
    title: 'New {issueTypeName} in {projectKey}',
    target: ['projectKey', 'issueTypeName', 'parent'],
    chips: ['assignee_account_id'],
    subject: 'summary',
    body: 'description',
    edit: { description: 'markdown' },
    labels: { projectKey: 'project', issueTypeName: 'type', assignee_account_id: 'assignee' },
  },
  {
    id: 'jira.add_comment',
    tool: 'mcp__*__addCommentToJiraIssue',
    layout: 'message',
    kind: 'comment',
    name: 'Jira',
    verb: 'Comment',
    target: ['issueIdOrKey'],
    body: 'commentBody',
    edit: { commentBody: 'markdown' },
    labels: { issueIdOrKey: 'issue' },
  },

  // Sentry
  {
    id: 'sentry.update_issue',
    tool: 'mcp__*sentry*__update_issue',
    layout: 'ticket',
    kind: 'update',
    name: 'Sentry',
    verb: 'Update',
    title: 'Update {issueId}',
    target: ['organizationSlug', 'issueId', 'issueUrl'],
    chips: ['status', 'assignedTo'],
    edit: { status: ['resolved', 'resolvedInNextRelease', 'unresolved', 'ignored'] },
    labels: { organizationSlug: 'org', issueId: 'issue', issueUrl: 'issue', assignedTo: 'assignee' },
  },

  // GitHub's MCP server (gh in Bash is a different path)
  {
    id: 'github.create_issue',
    tool: 'mcp__*github*__create_issue',
    layout: 'ticket',
    kind: 'ticket',
    name: 'GitHub',
    verb: 'Create',
    title: 'New issue in {owner}/{repo}',
    target: ['owner', 'repo'],
    chips: ['labels', 'assignees', 'milestone'],
    subject: 'title',
    body: 'body',
    edit: { body: 'markdown' },
  },
  {
    id: 'github.add_issue_comment',
    tool: 'mcp__*github*__add_issue_comment',
    layout: 'message',
    kind: 'comment',
    name: 'GitHub',
    verb: 'Comment',
    title: 'Comment on {owner}/{repo}#{issue_number}',
    target: ['owner', 'repo', 'issue_number'],
    body: 'body',
    edit: { body: 'markdown' },
    labels: GITHUB_LABELS,
  },
  {
    id: 'github.create_pull_request',
    tool: 'mcp__*github*__create_pull_request',
    layout: 'ticket',
    kind: 'pr',
    name: 'GitHub',
    verb: 'Open PR',
    title: 'PR into {owner}/{repo}',
    target: ['owner', 'repo', 'base', 'head'],
    chips: ['draft'],
    subject: 'title',
    body: 'body',
    edit: { body: 'markdown' },
  },

  // Notion
  { id: 'notion.create_pages', tool: 'mcp__*__notion-create-pages', layout: 'ticket', kind: 'post', name: 'Notion', verb: 'Create', target: ['parent'], body: 'pages' },
]

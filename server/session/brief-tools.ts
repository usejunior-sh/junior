import { gitReadCommand } from '../../core/actions/commands.js'

/**
 * Tools a headless brief session never gets, whatever it asks (belt to the
 * gate's braces). Junior's own writes are hidden too, not just denied: a brief
 * that can see update_artifact reaches for it to revise itself, and the brief's
 * one write is write_brief.
 */
export const BRIEF_DISALLOWED_TOOLS = [
  'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'AskUserQuestion',
  ...['create_work_item', 'edit_work_item', 'upsert_work_item', 'resolve_work_item', 'hand_off_work_item', 'draft_job', 'try_job',
    'write_artifact', 'update_artifact', 'link_artifact',
    'propose_team', 'split_step', 'revise_plan', 'submit_step', 'goal_verdict', 'goal_unstick', 'ask_you',
    'add_to_today', 'remove_from_today', 'set_reply_style', 'set_focus_hours', 'end_focus'].map((t) => `mcp__junior__${t}`),
]
/** The only shell a brief may run: `gh`/`git` read verbs, no chaining or redirection. */
export const briefBashAllowed = (input: Record<string, unknown>): boolean => gitReadCommand(typeof input.command === 'string' ? input.command : '')

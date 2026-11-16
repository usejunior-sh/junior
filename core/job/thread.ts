/**
 * A thread job's run (mode: thread): a scheduled message to the job's agent,
 * worked as a thread from that agent's DM. The message is the job's
 * instruction, marked as a job run so neither the model nor the user ever
 * reads it as something the user typed. Pure; time is an argument.
 */
import type { JobRunMark } from '../../shared/protocol.js'
import type { JobRunTrigger } from './types.js'

/** What marks a thread's opening message as a job run, on the event and in the transcript. */
export type { JobRunMark }

/** The reply that says a run found nothing: the thread stays quiet and is put away. */
export const NOTHING_NEW = 'Nothing new.'

/** The reply opens with "Nothing new", in any case, with or without a period. */
export function isNothingNew(said: string): boolean {
  return /^\s*[*_]*nothing new\b/i.test(said)
}

/** The thread's title: the job's, then the run's local time ("Log check · 14:00"). */
export function jobThreadTitle(title: string, at: number): string {
  const d = new Date(at)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${title} · ${hh}:${mm}`
}

const TRIGGER_TEXT: Record<JobRunTrigger, string> = {
  scheduled: 'on its schedule',
  catch_up: 'as a catch-up for slots the Mac slept through',
  manual: 'because the user pressed Run now',
  redraft: 'again, with the user’s notes',
}

/**
 * What the model reads for a job run's message: who sent it (the job, not
 * the user), how to report, how to stay quiet, and how not to redo work an
 * earlier run did. Then the instruction, as the user wrote it.
 */
export function frameJobMessage(mark: JobRunMark, instruction: string): string {
  const when = new Date(mark.runAt).toISOString()
  const lines = [
    `[Job run: "${mark.title}"${mark.every ? `, ${mark.every}` : ''}. Run ${TRIGGER_TEXT[mark.trigger]} at ${when}.`,
    'This is a scheduled run of a job the user set up, not a message the user typed. Nobody is watching live: do the job as written, without asking first.',
    'Anything that leaves this machine (a comment, a message, a push) is held on a card for the user, as always.',
    `If there is nothing to do this time, reply with exactly "${NOTHING_NEW}" and stop. That reply stays quiet: the user does not hear about it.`,
    'Otherwise start your last reply with one plain sentence that says the outcome; your DM shows only that sentence. Details after it.',
    'Earlier runs of this job may have handled some of what you find. Before working one thing (a PR, an error, a thread), call job_seen with its link; skip it if an earlier run handled it. After you handle it, call job_handled with the link, so later runs skip it too.',
    ...(mark.lateness ? [mark.lateness] : []),
    ']',
    '',
    instruction.trim(),
  ]
  return lines.join('\n')
}

/** A session that is one of a job's runs: a scan's headless run, or a thread job's thread. */
export const isJobRunRow = (r: { kind?: string | null; jobId?: string | null }): boolean => r.kind === 'job-run' || (r.kind === 'chat' && !!r.jobId)

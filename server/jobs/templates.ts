/**
 * Curated job templates (curated-recipes): weekly chores a senior engineer
 * hands off, shipped as files in `jobs/` and seeded OFF. They sit in the Jobs
 * list ready to read, try and turn on; nothing runs until the user says so.
 *
 * Each one is tight on purpose:
 *   - reads only: GitHub's read verbs (`gh`, no `gh api`) and the project's
 *     code. No send tool is granted, so nothing can go out; a run's hold
 *     would still stop one if a user adds it later.
 *   - files to the inbox only: items, or one private digest.
 *   - a per-run and a daily budget.
 *
 * No impact-notes or brag-doc template: that is a later bet, not a chore.
 */
import { builtinGrant } from '../../core/job/tools.js'
import type { JobFileSpec } from '../job-files.js'

export type JobTemplate = Omit<JobFileSpec, 'id' | 'project'>

const DEPENDENCY_PRS = `Sweep the open dependency update pull requests in this repository (Dependabot, Renovate and other bots that bump versions).

List them with \`gh pr list\`, then read each one's checks with \`gh pr checks\`. File one item per pull request that needs a person:
- its checks are failing, or
- it is a major version bump, or
- it has been open more than 7 days.

Say in each item which of these applies, the package and the version change, and the failing check if there is one. Skip green minor and patch updates that are less than a week old. Do not comment, approve, merge or close anything.`

const FLAKY_TESTS = `Find tests that look flaky on this repository's default branch.

Read the CI runs since the last run with \`gh run list\` and \`gh run view\` (use \`--log-failed\` for the failing step). A test is likely flaky when it failed and then passed on a re-run of the same commit, or failed on one commit and passed on the next without a change to the code it covers.

File one item per flaky test: the test's name and file, how often it failed in the window, links to a failing and a passing run, and the error line. Read the test's code and say in a sentence what looks timing-, order- or environment-dependent. Do not re-run jobs, open issues or comment anywhere.`

const RELEASE_NOTES = `Draft this week's release notes for this repository. They are a private draft for me to edit; nothing is published.

Read the pull requests merged into the default branch since the last run with \`gh pr list --state merged\` and \`gh pr view\`, and the commits with \`git log\`. Group the changes under: New, Improved, Fixed, and Under the hood. One short line per change, in plain words a user would follow, with the pull request link. Lead with the two or three changes worth calling out. Leave out bot dependency bumps unless one fixes a security issue.`

/** The curated templates by file name (`jobs/<name>.md`). Every one is off. */
export const CURATED_TEMPLATES: Record<string, JobTemplate> = {
  'dependency-prs': {
    title: 'Dependency PR sweep',
    schedule: '0 9 * * 1',
    tools: [builtinGrant('github')],
    model: 'sonnet',
    output: 'items',
    budgetUsd: 0.5,
    dailyBudgetUsd: 1,
    notify: 'on_failure',
    enabled: false,
    instruction: DEPENDENCY_PRS,
  },
  'flaky-tests': {
    title: 'Flaky test triage',
    schedule: '0 9 * * 1-5',
    tools: [builtinGrant('github')],
    model: 'sonnet',
    output: 'items',
    budgetUsd: 0.75,
    dailyBudgetUsd: 1.5,
    notify: 'on_failure',
    enabled: false,
    instruction: FLAKY_TESTS,
  },
  'release-notes': {
    title: 'Weekly release notes draft',
    schedule: '0 15 * * 5',
    tools: [builtinGrant('github')],
    model: 'sonnet',
    output: 'digest',
    budgetUsd: 0.75,
    dailyBudgetUsd: 1.5,
    notify: 'on_failure',
    enabled: false,
    instruction: RELEASE_NOTES,
  },
}

/** Template file names → stable job ids (`template-<name>`), all in one project. */
export function curatedTemplateFiles(project: string): Record<string, JobFileSpec> {
  return Object.fromEntries(
    Object.entries(CURATED_TEMPLATES).map(([name, t]) => [name, { id: `template-${name}`, project, ...t }]),
  )
}

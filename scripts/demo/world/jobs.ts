import { ID } from './base.js'

export type DemoJob = {
  id: string
  file: string
  title: string
  schedule: string
  tools: string[]
  output: 'items' | 'digest'
  enabled: boolean
  instruction: string
  /** per past run, newest last: matches filed (null = failed) */
  runs: (number | null)[]
}

export function jobs(): DemoJob[] {
  return [
    {
      id: ID.job.prSweep,
      file: 'pr-review-sweep',
      title: 'Morning PR review sweep',
      schedule: '30 8 * * 1-5',
      tools: ['github'],
      output: 'items',
      enabled: true,
      instruction:
        'Find open PRs in acme/api and acme/web where my review is requested or I was mentioned since yesterday. File one item per PR; say in one line what the PR changes and how big it is.\n\nNever comment, approve or request changes.',
      runs: [3, 1, 2, 4, 2, 1, 2],
    },
    {
      id: ID.job.sentry,
      file: 'sentry-spikes',
      title: 'Sentry error spikes after deploys',
      schedule: '0 10,14,18 * * 1-5',
      tools: ['web'],
      output: 'items',
      enabled: true,
      instruction:
        'Check Sentry for acme-api issues whose event rate is 10x their 7-day baseline, or that first appeared after the latest deploy. File one item per issue with the rate, the baseline and the suspect deploy.\n\nNever resolve, assign or mute issues.',
      runs: [0, 1, 0, null, 0, 2, 1],
    },
    {
      id: ID.job.linear,
      file: 'linear-assigned',
      title: 'Linear tickets assigned to me',
      schedule: '0 9 * * 1-5',
      tools: ['web'],
      output: 'items',
      enabled: true,
      instruction: 'List Linear issues in team ACME newly assigned to me or moved back to me. File each with its priority and due date.\n\nNever change an issue\'s state.',
      runs: [2, 0, 1, 1, 3, 0, 1],
    },
    {
      id: ID.job.deps,
      file: 'dependabot-junior',
      title: 'Dependabot junior',
      schedule: '0 11 * * 1',
      tools: ['github'],
      output: 'items',
      enabled: true,
      instruction:
        'Go through open Dependabot PRs in acme/api. Ignore patch bumps with green CI. File security fixes and major bumps, saying what breaks and which call sites need a change.\n\nNever merge or close a PR.',
      runs: [1, 0, 2, 1, 0, 1, 1],
    },
    {
      id: ID.job.escalations,
      file: 'support-escalations',
      title: 'Customer escalations in #support',
      schedule: '0 12,17 * * 1-5',
      tools: ['web'],
      output: 'items',
      enabled: true,
      instruction: 'Find threads in #support from the last half day that name the API, a 5xx or a rate limit and have no engineer reply yet. File each with the customer and the ask.\n\nNever post in the channel.',
      runs: [1, 0, 0, 2, 1, 0, 1],
    },
    {
      id: ID.job.digest,
      file: 'weekly-shipped-digest',
      title: 'Weekly digest: what shipped',
      schedule: '0 16 * * 5',
      tools: ['github'],
      output: 'digest',
      enabled: false,
      instruction: 'Summarise PRs merged into acme/api and acme/web this week, grouped by area, with one line each.',
      runs: [1, 1, 1],
    },
  ]
}

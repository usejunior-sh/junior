export const LOGIN = 'alexr'
export const WORKSPACE_NAME = 'Acme'
export const REPOS = ['acme/api', 'acme/web']
export const MODEL = 'opus'

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR

/** Fixed ids, so scenes can address them (`#<sessionId>`, `#/item/<id>`). */
export const ID = {
  project: 'demo-api',
  s: {
    // the dispatched session that finished: transcript → PR → "To review"
    fixN1: '0d3e5a1c-4b7e-4f0a-9c2e-1a6f00000001',
    // in flight (AI working)
    paginate: '0d3e5a1c-4b7e-4f0a-9c2e-1a6f00000002',
    // drafted a Slack reply, held for approval (Needs you now + Actions)
    replyPriya: '0d3e5a1c-4b7e-4f0a-9c2e-1a6f00000003',
    flags: '0d3e5a1c-4b7e-4f0a-9c2e-1a6f00000004',
    latency: '0d3e5a1c-4b7e-4f0a-9c2e-1a6f00000005',
  },
  job: {
    prSweep: '6a0b1f2e-0000-4c1d-8e7f-000000000001',
    sentry: '6a0b1f2e-0000-4c1d-8e7f-000000000002',
    linear: '6a0b1f2e-0000-4c1d-8e7f-000000000003',
    deps: '6a0b1f2e-0000-4c1d-8e7f-000000000004',
    escalations: '6a0b1f2e-0000-4c1d-8e7f-000000000005',
    digest: '6a0b1f2e-0000-4c1d-8e7f-000000000006',
  },
  item: {
    ciRedis: 'github:acme/api#482',
    priya: 'slack:C04ENGPAY/p1760440200123',
    stripe: 'linear:ACME-212',
    soc2: 'linear:ACME-198',
    applePay: 'github:acme/web#1290',
    idempotency: 'github:acme/api#477',
    marcus: 'slack:C02PLATFORM/p1760431100456',
    flakyBilling: 'linear:ACME-231',
    sentryPdf: 'web:sentry.io/acme/issues/48213',
    memcached: 'linear:ACME-219',
    undici: 'github:acme/api#471',
    paginate: 'linear:ACME-229',
    n1: 'linear:ACME-224',
    billingTab: 'github:acme/web#1284',
    node22: 'github:acme/api#479',
    loadTest: 'linear:ACME-205',
  },
  manual: {
    oncall: 'manual:3f1c9a52-7d1e-4f60-a2b4-6c0de0000001',
    flags: 'manual:3f1c9a52-7d1e-4f60-a2b4-6c0de0000002',
    incident: 'manual:3f1c9a52-7d1e-4f60-a2b4-6c0de0000003',
    pg18: 'manual:3f1c9a52-7d1e-4f60-a2b4-6c0de0000004',
  },
} as const

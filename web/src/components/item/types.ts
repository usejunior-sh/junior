import type { SessionSummary } from '../../../../shared/protocol.js'

export type LinkedSession = { s: SessionSummary; role: string }

export type CostSplit = { model: string; cost: number; tokens: number; priced: boolean; color: string }

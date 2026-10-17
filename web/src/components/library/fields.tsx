import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import type { LibrarySource, LibraryKind } from '../../../../shared/protocol.js'

export type Filter = 'all' | LibrarySource | 'team'

export const SOURCE_LABEL: Record<Filter, string> = {
  all: 'All',
  workspace: 'Workspace',
  personal: 'Personal',
  project: 'Projects',
  plugin: 'Plugins',
  team: 'Teams',
}

export const SOURCE_HINT: Record<LibrarySource | 'team', (kind: LibraryKind) => string> = {
  workspace: (k) => `This workspace’s own — its sessions load them as ${k === 'skill' ? '/triage:<name>' : 'triage:<name>'}.`,
  personal: () => 'Yours, in every Claude Code session on this machine.',
  project: () => 'Checked into the project — for everyone who works in it.',
  plugin: () => 'From an installed plugin — read-only; updates replace them.',
  team: () => 'The agents team runs are made of. Chats don’t see these.',
}

/** The phone's way back from an editor to the list (hidden where both show at once). */
export function BackToList({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="iconBtn lbBack" aria-label="Back to the list" title="Back" onClick={onBack}>
      <ArrowLeft size={14} aria-hidden="true" />
    </button>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="lbField">
      <span className="lbFieldK">{label}</span>
      <span className="lbFieldV">
        {children}
        {hint && <span className="lbHint">{hint}</span>}
      </span>
    </label>
  )
}

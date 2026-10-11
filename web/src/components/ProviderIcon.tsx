/**
 * The agent a session runs on, as a mark drawn in lucide's grammar (24px box,
 * 2px round strokes, currentColor) so it sits beside the rest of the icon set.
 * Not the vendors' logos — a starburst for Claude, a prompt in a hexagon for Codex.
 */
import type { ProviderId } from '../../../shared/protocol.js'

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  claude: 'Claude',
  codex: 'Codex',
}

const RAYS = [0, 45, 90, 135, 180, 225, 270, 315]

export function ProviderIcon({ provider, size = 16 }: { provider: ProviderId; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {provider === 'claude' ? (
        RAYS.map((deg, i) => <line key={deg} x1="12" y1={i % 2 ? 8.5 : 7.5} x2="12" y2={i % 2 ? 4 : 2.5} transform={`rotate(${deg} 12 12)`} />)
      ) : (
        <>
          <path d="M12 2.5 20.5 7.25v9.5L12 21.5 3.5 16.75v-9.5z" />
          <path d="m8.5 10 2.5 2-2.5 2" />
          <path d="M13 14.5h3" />
        </>
      )}
    </svg>
  )
}

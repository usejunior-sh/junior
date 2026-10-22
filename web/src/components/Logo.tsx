import lockupUrl from '@assets/brand/junior-lockup.svg'

/**
 * The Junior mark: three strokes at sixty degrees, bottom-aligned, each shorter
 * than the last, ending in a dot. Drawn on a 48-unit grid at a single 5.5 stroke
 * with round caps; fills from `currentColor` so it takes the surrounding text
 * colour. The source of truth for the geometry is assets/brand/junior-mark.svg.
 */
export function JuniorMark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={5.5}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M9 40 L25 12.3" />
      <path d="M20 40 L30 22.7" />
      <path d="M31 40 L36 31.3" />
      <circle cx="42.5" cy="40" r="2.9" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * Mark + wordmark lockup, rendered from the brand source of truth
 * (assets/brand/junior-lockup.svg). Painted as a mask filled with the current
 * text colour, so the single white-on-transparent file adapts to the theme.
 */
export function JuniorLogo({ className }: { className?: string }) {
  return (
    <span className={`logo${className ? ` ${className}` : ''}`} role="img" aria-label="junior">
      <span
        className="logoLockup"
        aria-hidden="true"
        style={{ WebkitMaskImage: `url("${lockupUrl}")`, maskImage: `url("${lockupUrl}")` }}
      />
    </span>
  )
}

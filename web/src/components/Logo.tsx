import markUrl from '@assets/brand/junior-mark.svg'
import iconUrl from '@assets/brand/icon.svg'
import wordmarkUrl from '@assets/brand/junior-wordmark.svg'
import wordmarkBlackUrl from '@assets/brand/junior-wordmark-black.svg'

/**
 * The Junior mark: the sky J key with a face (brand v2,
 * .docs/junior-goals-teams/junior-brand-v2.html). Its colours are the brand's,
 * never the theme's. Below 48px it draws `icon.svg`, which drops the eye
 * highlights so the face survives at 16px.
 */
export function JuniorMark({ size = 18, className }: { size?: number; className?: string }) {
  return <img className={className} src={size < 48 ? iconUrl : markUrl} width={size} height={size} alt="" aria-hidden="true" />
}

/**
 * The wordmark alone, from the brand files (assets/brand/junior-wordmark*.svg):
 * white on dark schemes, black on light ones, the orange dot on the i as it is.
 * No key here: the rail's face is Junior, and two faces side by side read as two
 * characters. The full lockup stays on the splash and the site.
 */
export function JuniorLogo({ className }: { className?: string }) {
  return (
    <span className={`logo${className ? ` ${className}` : ''}`} role="img" aria-label="Junior">
      <img className="logoLockup logoOnDark" src={wordmarkUrl} alt="" aria-hidden="true" />
      <img className="logoLockup logoOnLight" src={wordmarkBlackUrl} alt="" aria-hidden="true" />
    </span>
  )
}

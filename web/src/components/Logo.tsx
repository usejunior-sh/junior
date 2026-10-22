import markUrl from '@assets/brand/junior-mark.svg'
import iconUrl from '@assets/brand/icon.svg'
import lockupUrl from '@assets/brand/junior-lockup.svg'
import lockupBlackUrl from '@assets/brand/junior-lockup-black.svg'

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
 * Key + wordmark lockup, from the brand files (assets/brand/junior-lockup*.svg).
 * The wordmark is white on dark schemes and black on light ones; the key and the
 * orange dot on the i stay as they are.
 */
export function JuniorLogo({ className }: { className?: string }) {
  return (
    <span className={`logo${className ? ` ${className}` : ''}`} role="img" aria-label="Junior">
      <img className="logoLockup logoOnDark" src={lockupUrl} alt="" aria-hidden="true" />
      <img className="logoLockup logoOnLight" src={lockupBlackUrl} alt="" aria-hidden="true" />
    </span>
  )
}

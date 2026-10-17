import { Zap } from 'lucide-react'
import type { FastModeDisabledReason, FastModeState } from '../../../shared/protocol.js'
import { FAST_MODE_BLURB, fastModeReason, modelSupportsFastMode } from '../fastMode.js'
import { findModel, useModels } from '../models.js'

type Props = {
  /** The model this session runs on: fast mode is a property of the model. */
  model?: string
  /** What the user asked for. */
  fastMode?: boolean
  /** What the live subprocess reports; absent before it has said anything. */
  state?: FastModeState
  reason?: FastModeDisabledReason
  onChange: (on: boolean) => void
  disabled?: boolean
}

/**
 * A binary the user flips, so a plain toggle chip rather than a menu. The
 * chip is both the control and the readout. When the session says it asked for
 * fast mode and the subprocess says it isn't serving, the chip shows that
 * disagreement instead of quietly claiming speed it isn't getting.
 */
export function FastModeToggle({ model, fastMode, state, reason, onChange, disabled }: Props) {
  const models = useModels()
  const supported = modelSupportsFastMode(models, model)
  const modelName = findModel(models, model)?.name ?? 'This model'

  // Only meaningful once it is on: off is off, whatever the subprocess thinks.
  const blocked = Boolean(fastMode) && (state === 'cooldown' || Boolean(reason) || state === 'off')

  const title = !supported
    ? `${modelName} does not support fast mode.`
    : !fastMode
      ? `Turn on fast mode — ${FAST_MODE_BLURB}`
      : state === 'cooldown'
        ? 'Fast mode is paused after a rate limit; turns run at standard speed until it clears.'
        : blocked
          ? `Fast mode is on, but not serving: ${fastModeReason(reason)}.`
          : `Fast mode is on. ${FAST_MODE_BLURB}`

  return (
    <button
      type="button"
      className={`chip fast${fastMode ? (blocked ? ' blocked' : ' on') : ''}`}
      aria-pressed={Boolean(fastMode)}
      disabled={disabled || !supported}
      title={title}
      onClick={() => onChange(!fastMode)}
    >
      <Zap size={12} aria-hidden="true" />
      <span className="name">Fast</span>
    </button>
  )
}

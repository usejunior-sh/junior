import { memo } from 'react'
import type { PermissionBehavior } from '../../../shared/protocol.js'
import { truncate, type TranscriptItem } from '../transcript.js'
import { Markdown } from './Markdown.js'
import type { RefIndex } from '../refs.js'
import { JuniorLabel } from './JuniorLabel.js'

type Permission = Extract<TranscriptItem, { kind: 'permission' }>

type Props = {
  item: Permission
  onRespond: (requestId: string, behavior: PermissionBehavior) => void
  /** Junior is the one asking (false: a subagent, named by the wrapper around the card) */
  junior?: boolean
}

/** A one-line why-you're-asked, shown for the calls a write-gating mode stops on. */
const EFFECT_BADGE: Record<string, { label: string; hint: string }> = {
  'external-write': { label: 'external', hint: 'Reaches outside this machine' },
  'local-write': { label: 'writes', hint: 'Changes files or state on this machine' },
}

export const PermissionCard = memo(function PermissionCard({ item, onRespond, junior = true }: Props) {
  const badge = item.effect ? EFFECT_BADGE[item.effect] : undefined
  return (
    <div className="perm">
      <div className="q">
        {junior ? (
          <JuniorLabel
            mood={item.resolved ? 'done' : 'needs'}
            say={
              item.resolved === 'allow'
                ? 'You allowed this'
                : item.resolved === 'allow_always'
                  ? 'You allowed this for the rest of the session'
                  : item.resolved === 'deny'
                    ? 'You said no, so I didn’t run it'
                    : item.resolved === 'expired'
                      ? 'This expired before you answered'
                      : 'I’ll wait for your OK before I run this'
            }
          >
            {' '}wants to use <b>{item.toolName}</b>
          </JuniorLabel>
        ) : (
          <>
            Wants to use <b>{item.toolName}</b>
          </>
        )}
        {badge && (
          <span className={`effect ${item.effect}`} title={badge.hint}>
            {badge.label}
          </span>
        )}
        {item.title && (
          <>
            <br />
            {item.title}
          </>
        )}
      </div>
      <pre className="well">{truncate(JSON.stringify(item.input, null, 2), 1200)}</pre>
      {item.resolved ? (
        <span className={`verdict ${item.resolved}`}>
          {item.resolved === 'allow'
            ? '✓ allowed'
            : item.resolved === 'allow_always'
              ? '✓ allowed — and not asked again this session'
              : item.resolved === 'deny'
                ? '✕ denied'
                : '— expired (session ended before it was answered)'}
        </span>
      ) : (
        <div className="actions">
          <button className="btn primary" onClick={() => onRespond(item.id, 'allow')}>
            Allow
          </button>
          {/* Only offered when the SDK handed over rules to widen; without
              them "always" would silently be a plain one-off allow. */}
          {item.canAlwaysAllow && (
            <button
              className="btn"
              title="Allow this, and stop asking for calls like it — for this session only"
              onClick={() => onRespond(item.id, 'allow_always')}
            >
              Always allow
            </button>
          )}
          <button className="btn danger" onClick={() => onRespond(item.id, 'deny')}>
            Deny
          </button>
        </div>
      )}
    </div>
  )
})

/**
 * Plan mode's plan (ExitPlanMode), read as the document it is and approved like a
 * PR: approve, and Junior codes in this session at its own permission level, with
 * the plan kept as a file on the session and its item; keep planning, and you say
 * what should change in the chat.
 */
export const PlanCard = memo(function PlanCard({
  item,
  plan,
  refs,
  onRef,
  onRespond,
  junior = true,
}: Props & { plan: string; refs?: RefIndex; onRef?: (hash: string) => void }) {
  return (
    <div className="perm planCard">
      <div className="q">
        {junior ? (
          <JuniorLabel
            mood={item.resolved ? 'done' : 'needs'}
            say={
              item.resolved === 'deny'
                ? 'You asked me to keep planning'
                : item.resolved === 'expired'
                  ? 'This expired before you answered'
                  : item.resolved
                    ? 'You approved this plan'
                    : 'I won’t edit anything until you approve this'
            }
          >
            ’s plan
          </JuniorLabel>
        ) : (
          'The plan'
        )}
        {!item.resolved && <span className="planHint">nothing has been edited yet</span>}
      </div>
      <div className="planBody">
        <Markdown text={plan} refs={refs} onRef={onRef} />
      </div>
      {item.resolved ? (
        <span className={`verdict ${item.resolved === 'allow_always' ? 'allow' : item.resolved}`}>
          {item.resolved === 'deny' ? '↺ kept planning' : item.resolved === 'expired' ? '— expired (session ended before it was answered)' : '✓ approved — coding'}
        </span>
      ) : (
        <div className="actions">
          <button className="btn primary" onClick={() => onRespond(item.id, 'allow')} title="Leave plan mode and code it, at this session's permission level">
            Approve plan
          </button>
          <button className="btn" onClick={() => onRespond(item.id, 'deny')} title="Stay in plan mode — then say what should change">
            Keep planning
          </button>
        </div>
      )}
    </div>
  )
})

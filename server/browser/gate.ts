import { BROWSER_SERVER, type ElementFacts, type ElementVerdict, clickVerdict, elementLabel, hostOf, isLocalUrl, keyVerdict, resolveUrl, typeVerdict } from '../../core/browser/policy.js'
import { hostAllowed, siteOf } from '../../core/browser/profiles.js'
import type { VetoDecision } from '../providers/types.js'
import { BrowserHub } from './hub.js'
import { PageDriver } from './page-driver.js'
import { browserProfiles } from './profiles.js'

/**
 * The browser's own step in a session's veto chain (.docs/browser.md →
 * Logged-in sites), ahead of the action hold. A profile can be signed in to
 * Gmail: one click there can send mail as the user. So on a page that isn't
 * on this machine, a click that commits (Send, Post, Merge, Delete…) or Enter
 * in a form asks the user in a chat and is refused in a job; Junior never
 * types a password there; a job opens only the sites its file names; a chat
 * asks once per site before it opens one.
 *
 * Returns null when the browser has no opinion (the chain goes on), else the
 * decision. An ask is noted on the page's memory, so the session's
 * permission handler puts it in front of the user instead of waving a
 * browser call through.
 */
export type BrowserGateContext = {
  hub: BrowserHub
  /** the tab key: the session's id (a dry run's preview id) */
  sessionId: string
  /** file: URLs inside it count as local */
  projectRoot: string
  mode: 'chat' | 'job'
  /** a job's `browser_sites`: browser_open outside them is refused */
  sites?: string[]
}

export type BrowserGate = (toolName: string, input: unknown) => Promise<VetoDecision | null>

const PREFIX = `mcp__${BROWSER_SERVER}__`

export const PASSWORD_REFUSAL = "Junior doesn't type passwords on sites. Ask the user to sign in in the browser pane, then carry on."

export async function browserGate(ctx: BrowserGateContext, toolName: string, input: unknown): Promise<VetoDecision | null> {
  if (!toolName.startsWith(PREFIX)) return null
  const leaf = toolName.slice(PREFIX.length)
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const mem = ctx.hub.page(ctx.sessionId)
  // the user has the tab: the tool itself says so, nothing to ask about
  if (mem.heldByUser) return null
  // a dialog blocks the page: the tool says so; only answering it is judged
  if (mem.dialog && !(leaf === 'browser_act' && i.action === 'dialog')) return null

  const ask = (reason: string): VetoDecision => {
    mem.noteAsk(toolName, input, reason)
    return { allow: false, ask: true, reason }
  }
  const profileName = async (ref?: unknown) => {
    const p = typeof ref === 'string' && ref.trim() ? browserProfiles().find(ref) : browserProfiles().get((await ctx.hub.resolve(ctx.sessionId)).profile)
    return p?.name ?? 'Default'
  }

  if (leaf === 'browser_open') {
    if (typeof i.url !== 'string') return null
    const url = resolveUrl(i.url, mem.url)
    // the tool says what is wrong with a URL it can't open
    if (!url || isLocalUrl(url, ctx.projectRoot)) return null
    if (ctx.mode === 'job') {
      if (typeof i.profile === 'string' && i.profile.trim()) return { allow: false, reason: 'A job uses the profile its file names; leave out profile.' }
      return hostAllowed(ctx.sites, url) ? null : { allow: false, reason: `This job may only open ${ctx.sites!.join(', ')}. ${hostOf(url)} is not one of them.` }
    }
    if (mem.sites.has(siteOf(new URL(url).hostname))) return null
    return ask(`Open ${hostOf(url)} as ${await profileName(i.profile)}? Junior asks once per site in a chat.`)
  }

  if (leaf !== 'browser_act' && leaf !== 'browser_fill') return null
  // Everything is free on this machine: that is what testing is.
  const here = mem.url
  if (!here || isLocalUrl(here, ctx.projectRoot)) return null
  if (!ctx.hub.status.compatible) return null // the tool answers "open Triage.app"

  const d = new PageDriver(ctx.hub, ctx.sessionId)
  const facts = async (uid: unknown): Promise<ElementFacts | null> => (typeof uid === 'number' ? d.describe(uid).catch(() => null) : null)
  const host = hostOf(here)
  const as = await profileName()

  const verdicts: { v: ElementVerdict; what: string }[] = []
  if (leaf === 'browser_act') {
    switch (i.action) {
      case 'click': {
        const el = await facts(i.uid)
        verdicts.push({ v: clickVerdict(el), what: `Click ${elementLabel(el)}` })
        break
      }
      case 'type': {
        const el = await facts(i.uid)
        verdicts.push({ v: typeVerdict(el), what: `Type into ${elementLabel(el)}` })
        if (i.submit === true) verdicts.push({ v: keyVerdict('Enter', el), what: `Press Enter in ${elementLabel(el)}` })
        break
      }
      case 'press': {
        const key = typeof i.text === 'string' ? i.text : ''
        const el = await facts(i.uid)
        verdicts.push({ v: keyVerdict(key, el ?? (i.uid == null ? await focused(d) : null)), what: `Press ${key}${el ? ` in ${elementLabel(el)}` : ''}` })
        break
      }
      case 'dialog':
        if (i.text !== 'dismiss' && mem.dialog && mem.dialog.type !== 'alert') verdicts.push({ v: 'commit', what: `Accept "${clip(mem.dialog.message)}"` })
        break
    }
  } else {
    for (const f of Array.isArray(i.fields) ? (i.fields as { uid?: unknown }[]) : []) {
      const el = await facts(f?.uid)
      verdicts.push({ v: typeVerdict(el), what: `Type into ${elementLabel(el)}` })
    }
    if (i.submit != null) {
      const el = await facts(i.submit)
      verdicts.push({ v: clickVerdict(el), what: `Click ${elementLabel(el)}` })
    }
  }

  if (verdicts.some((x) => x.v === 'password')) return { allow: false, reason: PASSWORD_REFUSAL }
  const risky = verdicts.find((x) => x.v === 'commit') ?? verdicts.find((x) => x.v === 'unsure')
  if (!risky) return null
  if (ctx.mode === 'job') {
    return {
      allow: false,
      reason:
        risky.v === 'commit'
          ? `A job can't do that on ${host}: "${risky.what}" may send or change something. Record what you found with your write tool instead.`
          : `A job can't do that on ${host}: there is no telling what "${risky.what}" does. Record what you found with your write tool instead.`,
    }
  }
  return ask(
    risky.v === 'commit'
      ? `${risky.what} on ${host} as ${as}? It may send or change something as you.`
      : `${risky.what} on ${host} as ${as}? Junior can't tell what it does.`,
  )
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The element that has focus: where a key with no uid lands. */
async function focused(d: PageDriver): Promise<ElementFacts | null> {
  try {
    const r = await d.cdp<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: 'document.activeElement' })
    if (!r.result.objectId) return null
    const { node } = await d.cdp<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId: r.result.objectId })
    return await d.describe(node.backendNodeId)
  } catch {
    return null
  }
}

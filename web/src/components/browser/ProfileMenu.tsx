/**
 * The profile chip at the left of the pane's toolbar: which cookie jar this
 * tab is in, and the switcher. Switching reopens the page in the other
 * profile (the daemon does it); New profile and Manage open Settings → Browser.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronDown, Plus, Settings2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BrowserProfile } from '../../../../shared/protocol.js'
import { PROFILE_COLOR_VAR, openBrowserSettings, profileSites, type ProfilesSnapshot } from '../../browser.js'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../ui/Menu.js'
import { Tooltip } from '../../ui/Tooltip.js'

export function ProfileDot({ profile, size = 8 }: { profile: Pick<BrowserProfile, 'color'> | null; size?: number }) {
  return (
    <span
      className="profDot"
      style={{ width: size, height: size, background: profile ? PROFILE_COLOR_VAR[profile.color] : 'var(--stone)' }}
      aria-hidden="true"
    />
  )
}

/** A chip that only shows the profile: a sign-in tab is pinned to its own. */
export function ProfileChipStatic({ profile }: { profile: BrowserProfile | null }) {
  return (
    <span className="bpProfile static" title={profile ? `Profile: ${profile.name}` : undefined}>
      <ProfileDot profile={profile} />
      <span className="nm">{profile?.name ?? 'Default'}</span>
    </span>
  )
}

export function ProfileMenu({
  snap,
  current,
  disabledReason,
  onPick,
  onPress,
}: {
  snap: ProfilesSnapshot | null
  /** the profile the tab is in */
  current: string
  /** set while switching isn't allowed: the tooltip says why */
  disabledReason: string | null
  onPick: (id: string) => void
  /** the chip is being pressed: the pane takes its frozen frame before the menu covers the page */
  onPress?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [sites, setSites] = useState<Record<string, string[]>>({})
  const connected = !!snap?.app.connected

  // The sites under each name come from the app's jars: read them as the menu opens.
  useEffect(() => {
    if (!open || !connected || !snap) return
    let live = true
    for (const p of snap.profiles) {
      void profileSites(p.id).then((b) => {
        if (live && b.ok) setSites((s) => ({ ...s, [p.id]: b.sites.slice(0, 2).map((x) => x.site) }))
      })
    }
    return () => {
      live = false
    }
  }, [open, connected, snap])

  const profile = snap?.profiles.find((p) => p.id === current) ?? null
  const chip = (
    <button type="button" className="bpProfile" disabled={!!disabledReason || !snap} onPointerDown={onPress} aria-label={`Profile: ${profile?.name ?? current}. Switch profile`}>
      <ProfileDot profile={profile} />
      <span className="nm">{profile?.name ?? current}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
  )

  if (disabledReason) {
    return (
      <Tooltip content={disabledReason} side="bottom">
        <span className="bpProfileWrap">{chip}</span>
      </Tooltip>
    )
  }

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger asChild>{chip}</MenuTrigger>
      <MenuContent className="bpProfileMenu" align="start">
        <DropdownMenu.Label className="bpMenuGroup">profiles</DropdownMenu.Label>
        <DropdownMenu.RadioGroup value={current} onValueChange={(id) => id !== current && onPick(id)}>
          {(snap?.profiles ?? []).map((p) => (
            <DropdownMenu.RadioItem key={p.id} value={p.id} className="uiMenuItem bpProfileItem">
              <ProfileDot profile={p} />
              <span className="nm">
                <b>
                  {p.name}
                  {p.id === snap?.workspaceDefault && <span className="star" title="This workspace's default"> ★</span>}
                </b>
                {(sites[p.id] ?? p.sites)?.length ? <small className="mono">{(sites[p.id] ?? p.sites ?? []).slice(0, 2).join(', ')}</small> : null}
              </span>
              <span className="chk">
                <DropdownMenu.ItemIndicator>
                  <Check size={13} aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </span>
            </DropdownMenu.RadioItem>
          ))}
        </DropdownMenu.RadioGroup>
        <MenuSeparator />
        <MenuItem onSelect={() => openBrowserSettings({ draft: true })}>
          <Plus size={14} aria-hidden="true" />
          New profile…
        </MenuItem>
        <MenuItem onSelect={() => openBrowserSettings()}>
          <Settings2 size={14} aria-hidden="true" />
          Manage profiles
        </MenuItem>
      </MenuContent>
    </Menu>
  )
}

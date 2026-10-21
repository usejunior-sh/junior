import { browserHub, runtimes } from '../workspace/runtime.js'
import { teamRunOf } from '../team-run/state.js'
import { workspaceBrowserProfile } from '../settings-ops.js'
import { broadcast } from '../ws/send.js'
import { browserProfiles } from './profiles.js'
import type { TabOwner } from './hub.js'

/**
 * Boot: teach the daemon-wide hub which workspace a tab belongs to. Session
 * ids are unique across workspaces, so the first runtime that knows the row
 * owns it. Also: every change to the profiles goes to every workspace.
 */
export function installBrowserOwners() {
  browserHub.setResolver((sessionId): TabOwner | null => {
    for (const rt of runtimes.values()) {
      if (!rt.rows.has(sessionId)) continue
      const run = teamRunOf(rt, sessionId)
      return {
        store: rt.store.browserTabs,
        defaultProfile: () => workspaceBrowserProfile(rt),
        leadSessionId: run && run.leadSessionId !== sessionId ? run.leadSessionId : null,
        broadcast: (msg) => broadcast(rt, msg),
      }
    }
    return null
  })
  browserProfiles().onChange(() => void broadcastProfiles())
}

/** The whole list, to every open page of every workspace (each with its own default). */
export async function broadcastProfiles() {
  const profiles = browserProfiles().list()
  for (const rt of runtimes.values()) broadcast(rt, { type: 'browser_profiles', profiles, workspaceDefault: await workspaceBrowserProfile(rt) })
}

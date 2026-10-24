/**
 * The work item under the keyboard cursor, for anything that wants to say
 * "this one" without asking the page (the friction capture). The Inbox and
 * the Junior page keep their cursor in local state; each sets this from an
 * effect when the cursor moves, and clears it on unmount.
 */
let current: string | null = null

export function setSelectedItem(id: string | null): void {
  current = id
}

export function selectedItem(): string | null {
  return current
}

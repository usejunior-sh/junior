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

/**
 * The item in focus, for anything that wants to say "this one": the item
 * page's item, else the open chat's item, else the keyboard cursor's. Used by
 * the friction capture (⌘⇧.) and the palette's "This item" group (⌘K).
 */
export function focusedItemId(
  route: { page: string; id?: string | null },
  sessions: readonly { id: string; itemId?: string | null }[],
  cursor: string | null = selectedItem(),
): string | null {
  if (route.page === 'item') return route.id ?? null
  if (route.page === 'session') return sessions.find((s) => s.id === route.id)?.itemId ?? null
  return cursor
}

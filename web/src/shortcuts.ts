/**
 * The app's global keys, as a list (for the `?` overlay and Settings →
 * Shortcuts) and the matchers that need no DOM. Pure: keys.ts touches
 * `document` at load, so tests read this file instead.
 */

/** ⌘⇧. on a Mac, Ctrl+Shift+. elsewhere: the friction capture's key, as shown. */
export const frictionKeyLabel = (mod: string) => (mod === '⌘' ? '⌘⇧.' : `${mod}Shift+.`)

/** Every global key. `mod` is `⌘` on a Mac, `Ctrl+` elsewhere (keys.ts MOD_LABEL). */
export function shortcutsFor(mod: string): ReadonlyArray<[keys: string, what: string]> {
  return [
    [`${mod}K`, 'Search — chats, items, projects, commands'],
    [`${mod},`, 'Settings'],
    [`${mod}B`, 'Hide / show the side panel'],
    [mod === '⌘' ? '⌘⌥B' : `${mod}Alt+B`, "Hide / show the chat's right sidebar"],
    [`${mod}J`, "Junior's chat (classic layout: a new chat with Junior)"],
    [`${mod}\\`, 'Hide / show the team sidebar'],
    [mod === '⌘' ? '⌃`' : 'Ctrl+`', 'New scratch terminal'],
    [frictionKeyLabel(mod), 'Note what annoyed you, for later'],
    ['n', 'New chat (in Tasks: new task)'],
    ['Shift+Tab', 'New chat: switch Solo / Ultracode'],
    ['g h', 'Go to Junior (home)'],
    ['g i', 'Go to Tasks'],
    ['g s', 'Go to Chats'],
    ['g t', 'Go to Terminals (n opens a new one there)'],
    ['g j', 'Go to Jobs'],
    ['g p', 'Projects (in Settings)'],
    ['g c', 'Connectors (in Settings)'],
    ['j / k', 'Tasks: move selection'],
    ['Enter', 'Tasks: open the selected item'],
    ['o', 'Tasks: open the selected item at its source · Junior: open the item'],
    ['d', 'Tasks: start a chat on the selected item · Junior: mark done'],
    ['b', 'Tasks: brief the selected item (or the checked ones)'],
    ['Space', 'Tasks: check / uncheck the selected item'],
    ['e', 'Tasks: mark selected item done'],
    ['z', 'Tasks: snooze selected item until tomorrow'],
    ['t / m / w / l', 'Tasks: due today / next workday / this week / later'],
    ['x', 'Tasks: archive selected item · Junior: not this one'],
    ['h', 'Junior: hand off the open row'],
    ['p', 'Junior: pause or resume the open row'],
    ['s', 'Junior: snooze the open row'],
    ['c', 'Junior: close with a note (on a Close? row)'],
    ['r', 'Tasks: refresh'],
    ['?', 'Keyboard shortcuts'],
    ['Esc', 'Close dialogs, or the thread open beside Junior’s chat'],
  ]
}

/**
 * ⌘⇧. (Ctrl+Shift+. off a Mac): the friction capture. Matched on the physical
 * key: with Shift held, `key` is `>` on a US layout and something else on others.
 */
export function isFrictionKey(e: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'code'>): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === 'Period'
}

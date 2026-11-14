import {
  ChevronDown,
  Plus,
  Settings2,
  SquareArrowOutUpRight,
  X,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Workspace } from "../../../shared/protocol.js";
import { desktopTabs, type DesktopTabsState } from "../desktop.js";
import { MOD_LABEL } from "../keys.js";
import { fitTabs } from "../tabStrip.js";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/Menu.js";

/**
 * Workspace tabs in Junior.app's bar (.docs/workspace-tabs/topbar-variations.html, B).
 * The app hosts one view per tab; this view draws the strip from the window's
 * tab list. A click shows another view, nothing reloads. The tab in front
 * keeps today's chevron menu; another tab shows its orange count, never more.
 */
export function WorkspaceTabs({
  state,
  workspaces,
  onNew,
  onSettings,
  trailing,
}: {
  state: DesktopTabsState;
  workspaces: readonly Workspace[];
  onNew: () => void;
  onSettings: () => void;
  /** after the + button: the build badge */
  trailing?: ReactNode;
}) {
  const t = desktopTabs!;
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const tabs = state.tabs.filter((tab) => byId.has(tab.id));
  const count = (id: string) => state.counts[id] ?? 0;

  // How much room the strip has: the whole zone up to the system icons, less the + and the badge.
  const wrap = useRef<HTMLDivElement>(null);
  const fixed = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(10_000);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const measure = () =>
      setWidth(el.clientWidth - (fixed.current?.offsetWidth ?? 0) - 8);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [plusOpen, setPlusOpen] = useState(false);
  useEffect(
    () => t.onCommand((c) => c === "open-menu" && setPlusOpen(true)),
    [t],
  );

  const fit = fitTabs(
    tabs.map((tab) => ({
      id: tab.id,
      lastActive: tab.lastActive,
      count: tab.id === state.active ? 0 : count(tab.id),
    })),
    state.active,
    width,
  );
  const open = new Set([
    ...state.tabs.map((tab) => tab.id),
    ...state.elsewhere.map((e) => e.id),
  ]);
  const closed = workspaces.filter((w) => !open.has(w.id));
  const elsewhere = state.elsewhere
    .map((e) => byId.get(e.id))
    .filter((w): w is Workspace => !!w);
  const foldedNeeds = fit.folded.some((id) => count(id) > 0);
  // ⌘-click or a middle click: the workspace in its own window, the switcher's rule.
  const wantsWindow = (e: {
    metaKey: boolean;
    ctrlKey: boolean;
    button: number;
  }) => e.metaKey || e.ctrlKey || e.button === 1;

  return (
    <div className="wsTabs" ref={wrap}>
      <div
        className={`wsTabRow${fit.short ? " short" : ""}`}
        role="tablist"
        aria-label="Workspaces"
      >
        {fit.shown.map((id) => {
          const w = byId.get(id)!;
          const n = count(id);
          if (id === state.active)
            return (
              <Menu key={id}>
                <MenuTrigger asChild>
                  <button
                    type="button"
                    role="tab"
                    aria-selected="true"
                    className="wsTab on"
                    title={`Workspace: ${w.name}`}
                  >
                    <span
                      className="wsDot"
                      style={{ background: w.color }}
                      aria-hidden="true"
                    />
                    <span className="wsTabName">{w.name}</span>
                    <ChevronDown
                      size={12}
                      className="wsTabChev"
                      aria-hidden="true"
                    />
                  </button>
                </MenuTrigger>
                <MenuContent align="start" className="wsMenu">
                  <MenuItem onSelect={onSettings}>
                    <Settings2 size={14} aria-hidden="true" />
                    Workspace settings…
                  </MenuItem>
                  {tabs.length > 1 && (
                    <MenuItem onSelect={() => t.move(id, "new")}>
                      <SquareArrowOutUpRight size={14} aria-hidden="true" />
                      <span className="wsMenuName">Open in new window</span>
                      <kbd className="wsKbd">{MOD_LABEL}⇧N</kbd>
                    </MenuItem>
                  )}
                  <MenuItem onSelect={() => t.close(id)}>
                    <X size={14} aria-hidden="true" />
                    <span className="wsMenuName">
                      {tabs.length > 1 ? "Close tab" : "Close window"}
                    </span>
                    <kbd className="wsKbd">{MOD_LABEL}W</kbd>
                  </MenuItem>
                  <p className="wsMenuNote">
                    Closing hides {w.name}. Its jobs keep running.
                  </p>
                </MenuContent>
              </Menu>
            );
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected="false"
              className="wsTab"
              title={`${w.name}${n ? ` — ${n} need${n === 1 ? "s" : ""} you` : ""}\n${MOD_LABEL}-click: its own window`}
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onClick={(e) =>
                wantsWindow(e) ? t.move(id, "new") : t.activate(id)
              }
              onAuxClick={(e) => e.button === 1 && t.move(id, "new")}
            >
              <span
                className="wsDot"
                style={{ background: w.color }}
                aria-hidden="true"
              />
              <span className="wsTabName">{w.name}</span>
              {n > 0 && <span className="wsCount">{n}</span>}
            </button>
          );
        })}
      </div>
      <div className="wsTabsFixed" ref={fixed}>
        {fit.folded.length > 0 && (
          <Menu>
            <MenuTrigger asChild>
              <button
                type="button"
                className="wsMore"
                title={`${fit.folded.length} more workspaces`}
              >
                +{fit.folded.length}
                {foldedNeeds && (
                  <span className="wsMoreDot" aria-label="needs you" />
                )}
                <ChevronDown size={12} aria-hidden="true" />
              </button>
            </MenuTrigger>
            <MenuContent align="start" className="wsMenu">
              {fit.folded.map((id) => (
                <WorkspaceRow
                  key={id}
                  w={byId.get(id)!}
                  n={count(id)}
                  onSelect={() => t.activate(id)}
                />
              ))}
            </MenuContent>
          </Menu>
        )}
        <Menu open={plusOpen} onOpenChange={setPlusOpen}>
          <MenuTrigger asChild>
            <button
              type="button"
              className="topIcon"
              title={`Open a workspace (${MOD_LABEL}T)`}
              aria-label="Open a workspace"
            >
              <Plus size={15} aria-hidden="true" />
            </button>
          </MenuTrigger>
          <MenuContent align="start" className="wsMenu wsPlusMenu">
            {closed.length > 0 && (
              <p className="wsMenuHead">Open a workspace</p>
            )}
            {closed.map((w) => (
              <WorkspaceRow
                key={w.id}
                w={w}
                n={count(w.id)}
                onSelect={(inWindow) => {
                  t.open(w.id, { newWindow: inWindow });
                  setPlusOpen(false);
                }}
                newWindow
              />
            ))}
            {elsewhere.length > 0 && (
              <p className="wsMenuHead">In another window</p>
            )}
            {elsewhere.map((w) => (
              <WorkspaceRow
                key={w.id}
                w={w}
                n={count(w.id)}
                onSelect={() => t.open(w.id)}
              >
                <span
                  className="wsBring"
                  role="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    t.move(w.id, "here");
                    setPlusOpen(false);
                  }}
                >
                  Bring here
                </span>
              </WorkspaceRow>
            ))}
            {(closed.length > 0 || elsewhere.length > 0) && <MenuSeparator />}
            <MenuItem onSelect={onNew}>
              <Plus size={14} aria-hidden="true" />
              New workspace…
            </MenuItem>
          </MenuContent>
        </Menu>
        {trailing}
      </div>
    </div>
  );
}

/** One workspace in a menu: dot, name, its orange count. `newWindow` adds the ↗ and ⌘-click. */
function WorkspaceRow({
  w,
  n,
  onSelect,
  newWindow,
  children,
}: {
  w: Workspace;
  n: number;
  onSelect: (inNewWindow: boolean) => void;
  newWindow?: boolean;
  children?: ReactNode;
}) {
  // Radix's onSelect carries no modifier; the pointer-down before it does.
  const mod = useRef(false);
  return (
    <MenuItem
      onPointerDown={(e) =>
        (mod.current =
          !!newWindow && (e.metaKey || e.ctrlKey || e.button === 1))
      }
      onSelect={() => {
        onSelect(mod.current);
        mod.current = false;
      }}
      title={
        newWindow ? `${w.name} — ${MOD_LABEL}-click: its own window` : w.name
      }
    >
      <span
        className="wsDot"
        style={{ background: w.color }}
        aria-hidden="true"
      />
      <span className="wsMenuName">{w.name}</span>
      {n > 0 && <span className="wsCount">{n}</span>}
      {newWindow && (
        <span
          className="wsOpenTab"
          aria-hidden="true"
          title="Open in its own window"
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(true);
          }}
        >
          <SquareArrowOutUpRight size={12} aria-hidden="true" />
        </span>
      )}
      {children}
    </MenuItem>
  );
}

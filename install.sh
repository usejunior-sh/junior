#!/bin/sh
# Install Junior.app — a native macOS window over the local Junior daemon.
#
#   curl -fsSL https://usejunior.sh/install.sh | sh
#
# Environment:
#   JUNIOR_VERSION      version to install (default: the latest GitHub release)
#   JUNIOR_APP_ZIP      install this local zip instead of downloading one
#   JUNIOR_INSTALL_DIR  where Junior.app goes (default: /Applications, else ~/Applications)
#   JUNIOR_NO_OPEN=1    don't open the app when done
#
# Everything lives in main(), called on the last line, so a download cut short
# by the network runs nothing.

set -eu

REPO="usejunior-sh/junior"
APP="Junior.app"
BUNDLE_ID="sh.usejunior.app"
# Ours too: the Chrome-shim app `junior app install` wrote, before and after the rename.
KNOWN_IDS="sh.usejunior.app sh.usetriage.app com.heytriage.app"

if [ -t 1 ]; then
  TTY=1
  ESC=$(printf '\033')
  BOLD="${ESC}[1m" DIM="${ESC}[2m" RED="${ESC}[31m" RESET="${ESC}[0m"
  # The site's orange: truecolour where the terminal says it has it, else the
  # nearest of the 256 (Terminal.app before macOS 26 has no truecolour).
  case "${COLORTERM:-}" in
    truecolor | 24bit) ORANGE="${ESC}[38;2;255;122;69m" ;;
    *) ORANGE="${ESC}[38;5;209m" ;;
  esac
else
  TTY="" BOLD="" DIM="" RED="" RESET="" ORANGE=""
fi

step() { printf '  %s›%s %s\n' "$DIM" "$RESET" "$1"; }
ok() { printf '  %s✓%s %s\n' "$ORANGE" "$RESET" "$1"; }
die() {
  printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2
  exit 1
}

# The pulse — a braille spinner and a row of ▰/▱ blocks — drawn on one line
# that's redrawn in place. These set globals instead of printing, so a frame
# costs no subshells.
frame() {
  case $(($1 % 10)) in
    0) F='⠋' ;; 1) F='⠙' ;; 2) F='⠹' ;; 3) F='⠸' ;; 4) F='⠼' ;;
    5) F='⠴' ;; 6) F='⠦' ;; 7) F='⠧' ;; 8) F='⠇' ;; *) F='⠏' ;;
  esac
}

# blocks FROM COUNT WIDTH — BAR becomes WIDTH blocks, COUNT of them lit from FROM.
blocks() {
  BAR="" k=0
  while [ "$k" -lt "$3" ]; do
    if [ "$k" -ge "$1" ] && [ "$k" -lt $(($1 + $2)) ]; then
      BAR="${BAR}${ORANGE}▰${RESET}"
    else
      BAR="${BAR}${DIM}▱${RESET}"
    fi
    k=$((k + 1))
  done
}

pulse_start() { printf '%s[?25l' "$ESC"; }
pulse_end() { printf '\r%s[K%s[?25h' "$ESC" "$ESC"; }

# spin "label" cmd args… — runs cmd under the pulse, with a window of lit
# blocks sweeping across (there's no percent to show), clears the line when
# it's done, and returns cmd's status. Off a terminal, just runs.
spin() {
  label="$1"
  shift
  if [ -z "$TTY" ]; then
    "$@"
    return
  fi
  "$@" &
  pid=$!
  i=0
  pulse_start
  while kill -0 "$pid" 2>/dev/null; do
    frame "$i"
    blocks $((i % 15 - 3)) 3 12
    printf '\r  %s%s%s %s  %s' "$ORANGE" "$F" "$RESET" "$label" "$BAR"
    i=$((i + 1))
    sleep 0.1
  done
  pulse_end
  wait "$pid"
}

# fetch URL FILE — downloads under the pulse, the percent read off the file's
# size against Content-Length (curl's own bar can't be styled). Off a
# terminal, a plain quiet curl. Sets FETCHED_MB.
fetch() {
  if [ -z "$TTY" ]; then
    curl -fL -sS --retry 2 -o "$2" "$1" || return 1
  else
    total=$(curl -fsSIL "$1" 2>/dev/null | tr -d '\r' |
      awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }')
    curl -fL -sS --retry 2 -o "$2" "$1" 2>"$TMP/curl.err" &
    pid=$!
    i=0
    pulse_start
    while kill -0 "$pid" 2>/dev/null; do
      got=$(stat -f %z "$2" 2>/dev/null || echo 0)
      frame "$i"
      if [ "$total" -gt 0 ]; then
        pct=$((got * 100 / total))
        [ "$pct" -le 100 ] || pct=100
        blocks 0 $((pct / 5)) 20
        printf '\r  %s%s%s downloading  %s %s%3d%%%s  %s%d MB%s%s[K' "$ORANGE" "$F" "$RESET" "$BAR" \
          "$BOLD" "$pct" "$RESET" "$DIM" $((got / 1048576)) "$RESET" "$ESC"
      else
        # No length from the server: sweep, and count what's arrived.
        blocks $((i % 23 - 3)) 3 20
        printf '\r  %s%s%s downloading  %s  %s%d MB%s%s[K' "$ORANGE" "$F" "$RESET" "$BAR" \
          "$DIM" $((got / 1048576)) "$RESET" "$ESC"
      fi
      i=$((i + 1))
      sleep 0.1
    done
    pulse_end
    wait "$pid" || {
      sed 's/^/    /' "$TMP/curl.err" >&2
      return 1
    }
  fi
  FETCHED_MB=$(($(stat -f %z "$2") / 1048576))
}

# Silences a command but not the spinner around it: spin "…" quiet cmd…
quiet() { "$@" >/dev/null 2>&1; }

TMP=""
cleanup() {
  if [ -n "$TMP" ]; then rm -rf "$TMP"; fi
  # Ctrl-C mid-pulse would otherwise leave the cursor hidden.
  if [ -n "$TTY" ]; then printf '%s[?25h' "$ESC"; fi
}

detect_arch() {
  case "$(uname -m)" in
    arm64) echo arm64 ;;
    x86_64)
      # A shell under Rosetta reports x86_64 on Apple silicon.
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
        echo arm64
      else
        echo x64
      fi
      ;;
    *) die "unsupported architecture: $(uname -m) — we only build for Apple silicon and Intel" ;;
  esac
}

# Read off where releases/latest redirects (…/releases/tag/v1.2.3), not the
# API: that allows 60 unauthenticated calls an hour per IP, which one office
# network can use up.
latest_version() {
  curl -fsS -o /dev/null -w '%{redirect_url}' "https://github.com/$REPO/releases/latest" 2>/dev/null |
    sed -n 's|.*/releases/tag/v\{0,1\}\([^/?#]*\)$|\1|p'
}

bundle_id() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true
}

is_ours() {
  case " $KNOWN_IDS " in *" $1 "*) return 0 ;; esac
  return 1
}

# `is running` asks without launching; an id Launch Services doesn't know is "false".
is_running() {
  [ "$(osascript -e "application id \"$1\" is running" 2>/dev/null || echo false)" = true ]
}

# The health body of a daemon on the port, or empty when nothing answers.
daemon_health() {
  curl -fsS -m 2 "http://localhost:${JUNIOR_APP_PORT:-5178}/api/health" 2>/dev/null || true
}

# A numeric or string field out of a health body: health_field "$h" version
health_field() {
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"\{0,1\}\([^\",}]*\).*/\1/p" | head -n 1
}

# The version of a Junior daemon running out of $1 (a bundle path), if any.
# Quitting the app leaves its daemon up, still running the old bundle's code.
daemon_inside() {
  health=$(daemon_health)
  [ -n "$health" ] || return 0
  pid=$(health_field "$health" pid)
  [ -n "$pid" ] || return 0
  case "$(ps -o command= -p "$pid" 2>/dev/null)" in
    *"$1/"*) health_field "$health" version ;;
  esac
}

# `junior` and `junior-mcp` on PATH, forwarding into the app's bundled copy.
# Without these the app is the only way in: no `junior status`, no `junior logs`,
# and no MCP server for an external Claude Code session.
link_cli() {
  bin="${JUNIOR_BIN_DIR:-$HOME/.local/bin}"
  mkdir -p "$bin" 2>/dev/null || { step "couldn't create $bin — skipping the junior command, the app works without it"; return 0; }
  for name in junior junior-mcp; do
    target="$bin/$name"
    # Never clobber a real binary someone else installed; our own shim and a
    # symlink left dangling by `npm uninstall -g` are both fair game.
    if [ -e "$target" ] && ! grep -q 'Junior.app installer' "$target" 2>/dev/null; then
      step "left $target alone — it isn't ours, and we don't touch other people's things"
      continue
    fi
    case "$name" in
      junior) script=cli.js ;;
      *) script=mcp.js ;;
    esac
    rm -f "$target"
    cat >"$target" <<SHIM
#!/bin/sh
# Written by the Junior.app installer — runs the copy inside the app bundle,
# with the app's own Node (the server needs node:sqlite). Reinstall to repoint.
APP="$1"
[ -x "\$APP/Contents/Resources/node/bin/node" ] || {
  echo "junior: $1 is missing — reinstall from https://usejunior.sh" >&2
  exit 1
}
exec "\$APP/Contents/Resources/node/bin/node" "\$APP/Contents/Resources/junior/dist/server/$script" "\$@"
SHIM
    chmod 755 "$target"
  done
  ok "junior command → $bin"
  case ":$PATH:" in
    *":$bin:"*) ;;
    *) printf '    %sadd it to your PATH:%s export PATH="%s:$PATH"\n' "$DIM" "$RESET" "$bin" ;;
  esac
}

# Jobs are a background promise: they only run while the daemon runs, and a
# detached daemon dies on reboot. The LaunchAgent is what makes them durable,
# so it goes in by default rather than waiting to be discovered.
keep_running() {
  node="$1/Contents/Resources/node/bin/node"
  cli="$1/Contents/Resources/junior/dist/server/cli.js"
  [ -x "$node" ] && [ -f "$cli" ] || return 0
  # Installing stops whatever holds the port — fine when idle, not while a
  # session is mid-turn. Busy means we write nothing and say so.
  if [ "${live:-0}" -gt 0 ] 2>/dev/null; then
    printf '  %s!%s %s session(s) mid-thought, so we didn%st restart Junior under them.\n' "$BOLD" "$RESET" "$live" "'"
    printf '    Run %sjunior install%s when they finish, so jobs survive the next reboot.\n' "$BOLD" "$RESET"
    return 0
  fi
  if spin "asking launchd to keep Junior alive" quiet "$node" "$cli" install; then
    ok "LaunchAgent installed — Junior now outlives reboots ${DIM}(undo: junior uninstall)${RESET}"
  else
    printf '  %s!%s couldn%st install the LaunchAgent — jobs will stop at the next reboot.\n' "$BOLD" "$RESET" "'"
    printf '    Run %sjunior install%s and read the error — it%ss usually specific.\n' "$BOLD" "$RESET" "'"
  fi
}

# Before the rename this was Triage.app, with its own LaunchAgent and shims.
# Its daemon holds the port and ~/.triage, which the new daemon moves to
# ~/.junior on its first start, so the old one stops first. Busy means we
# leave it running and say so, like keep_running.
retire_triage() {
  old_agent="$HOME/Library/LaunchAgents/sh.usetriage.triage.plist"
  if [ -f "$old_agent" ] || is_running sh.usetriage.app; then
    if [ "${live:-0}" -gt 0 ] 2>/dev/null; then
      printf '  %s!%s the old Triage has %s session(s) mid-thought, so it stays up for now.\n' "$BOLD" "$RESET" "$live"
      printf '    Run this again when they finish, to move over to Junior.\n'
      return 0
    fi
    quit_app sh.usetriage.app
    launchctl bootout "gui/$(id -u)/sh.usetriage.triage" >/dev/null 2>&1 || true
    rm -f "$old_agent"
    i=0
    while [ -n "$(daemon_health)" ] && [ "$i" -lt 20 ]; do
      i=$((i + 1))
      sleep 0.5
    done
    live=0
    ok "stopped the old Triage"
  fi
  for old_app in "/Applications/Triage.app" "$HOME/Applications/Triage.app"; do
    if [ -d "$old_app" ] && [ "$(bundle_id "$old_app")" = sh.usetriage.app ]; then
      rm -rf "$old_app" 2>/dev/null && ok "removed $old_app"
    fi
  done
  bin="${JUNIOR_BIN_DIR:-$HOME/.local/bin}"
  for name in triage triage-mcp; do
    if grep -q 'Triage.app installer' "$bin/$name" 2>/dev/null; then rm -f "$bin/$name"; fi
  done
}

quit_app() {
  is_running "$1" || return 0
  step "quitting the running Junior — it'll be right back"
  osascript -e "tell application id \"$1\" to quit" >/dev/null 2>&1 || true
  i=0
  while is_running "$1"; do
    i=$((i + 1))
    [ "$i" -gt 20 ] && die "Junior won't quit — quit it yourself, then run this again"
    sleep 0.5
  done
}

main() {
  [ "$(uname -s)" = Darwin ] || die "Junior.app is macOS only, for now — on Linux: npm i -g usejunior"
  major=$(sw_vers -productVersion | cut -d. -f1)
  [ "$major" -ge 12 ] || die "Junior.app needs macOS 12 or newer"

  printf '\n  %sjunior%s %sfor macOS%s\n' "$BOLD" "$RESET" "$DIM" "$RESET"
  printf '  %syour work, ranked before you look%s\n\n' "$DIM" "$RESET"

  TMP=$(mktemp -d "${TMPDIR:-/tmp}/junior-install.XXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  zip="$TMP/Junior.zip"
  if [ -n "${JUNIOR_APP_ZIP:-}" ]; then
    [ -f "$JUNIOR_APP_ZIP" ] || die "no such file: $JUNIOR_APP_ZIP"
    cp "$JUNIOR_APP_ZIP" "$zip"
    ok "using $JUNIOR_APP_ZIP"
  else
    arch=$(detect_arch)
    version="${JUNIOR_VERSION:-}"
    version="${version#v}"
    if [ -z "$version" ]; then
      version=$(latest_version)
      [ -n "$version" ] || die "couldn't ask GitHub for the latest release — check your connection, or set JUNIOR_VERSION=x.y.z"
    fi
    asset="Junior-$version-mac-$arch.zip"
    url="https://github.com/$REPO/releases/download/v$version/$asset"
    [ -n "$TTY" ] || step "downloading $asset"
    started=$(date +%s)
    fetch "$url" "$zip" ||
      die "download failed: $url
    (a pinned JUNIOR_VERSION may predate the Mac app — try without it)"
    took=$(($(date +%s) - started))
    case "$arch" in arm64) chip="Apple silicon" ;; *) chip=Intel ;; esac
    ok "downloaded v$version ${DIM}($chip · $FETCHED_MB MB, mostly Chromium · ${took}s)${RESET}"
  fi

  # Unpack and check it before touching what's installed.
  spin "unpacking" ditto -x -k "$zip" "$TMP/unpacked" || die "not a zip archive"
  ok "unpacked"
  new="$TMP/unpacked/$APP"
  [ -d "$new" ] || die "the archive has no $APP at its top level"
  [ "$(bundle_id "$new")" = "$BUNDLE_ID" ] || die "$APP in the archive isn't $BUNDLE_ID"
  xattr -dr com.apple.quarantine "$new" 2>/dev/null || true
  spin "checking the signature" codesign --verify --deep --strict "$new" 2>/dev/null ||
    die "$APP failed its signature check — something changed it after we built it, so we're not installing it"
  ok "signature checks out ${DIM}(ad-hoc — paying Apple \$99 is on the roadmap)${RESET}"

  if [ -n "${JUNIOR_INSTALL_DIR:-}" ]; then
    dir="$JUNIOR_INSTALL_DIR"
  elif [ -w /Applications ]; then
    dir=/Applications
  else
    dir="$HOME/Applications"
  fi
  mkdir -p "$dir" || die "can't create $dir"
  [ -w "$dir" ] || die "$dir isn't writable — set JUNIOR_INSTALL_DIR"
  dest="$dir/$APP"

  quit_app "$BUNDLE_ID"
  # Read the running daemon once, before anything moves: whether it is busy
  # decides if we may restart it into the new version below.
  live=$(health_field "$(daemon_health)" liveSessions)
  [ -n "$live" ] || live=0
  stale=""
  if [ -e "$dest" ]; then
    stale=$(daemon_inside "$dest")
    old=$(bundle_id "$dest")
    is_ours "$old" || die "$dest is another app (${old:-no bundle id}) — move it aside or set JUNIOR_INSTALL_DIR"
    [ "$old" = "$BUNDLE_ID" ] || quit_app "$old"
    rm -rf "$dest" || die "couldn't remove the old $dest"
    ok "replaced the old $dest"
  else
    ok "installed $dest"
  fi
  mv "$new" "$dest"

  # A second copy with the same bundle id (e.g. the old `junior app install`
  # shim in the other Applications folder) would make Launch Services pick
  # either one. Only the default locations are checked.
  if [ -z "${JUNIOR_INSTALL_DIR:-}" ]; then
    for other in "/Applications/$APP" "$HOME/Applications/$APP"; do
      [ "$other" = "$dest" ] && continue
      if [ -d "$other" ] && is_ours "$(bundle_id "$other")"; then
        rm -rf "$other" 2>/dev/null && ok "removed an older copy at $other — two of us confuses macOS"
      fi
    done
  fi

  retire_triage
  link_cli "$dest"
  # Before opening the app: the agent brings the daemon up on the new version,
  # and the app then attaches to it instead of starting the old one again.
  keep_running "$dest"

  if [ "${JUNIOR_NO_OPEN:-}" != 1 ]; then
    open "$dest"
    ok "opened Junior"
  fi
  # Only still true if keep_running stood down for a busy daemon.
  if [ -n "$stale" ] && [ "${live:-0}" -gt 0 ] 2>/dev/null; then
    printf '  %s!%s Junior %s is still running from the old app — when no session is busy,\n' "$BOLD" "$RESET" "$stale"
    printf '    choose %sJunior › Restart Junior server…%s to switch to the new one\n' "$BOLD" "$RESET"
  fi

  cat <<EOF

  ${ORANGE}${BOLD}Junior is installed.${RESET}

  The app is only a window. Quit it and Junior keeps working: live
  sessions finish, jobs fire, and launchd brings it back after a
  reboot or a crash. Quitting the app doesn't send the staff home.

  ${DIM}junior status${RESET}     what's running, and which build
  ${DIM}junior uninstall${RESET}  stop it starting at login — no hard feelings

  One thing we can't bundle: Claude Code, logged in → ${DIM}https://claude.com/claude-code${RESET}
  To update, run the same curl line. An auto-updater is on the roadmap,
  right after paying Apple.

EOF
}

main "$@"

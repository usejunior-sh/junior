# Junior.app

A native macOS window over the local junior daemon. The daemon is still the
product: the app finds it, starts it if it isn't running, and shows its UI in a
window of its own. Nothing in `server/` or `core/` is ported. The design and the
`daemon.ts` contract are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Install

```sh
curl -fsSL https://usejunior.sh/install.sh | sh
```

[`install.sh`](../install.sh) downloads `Junior-<version>-mac-<arch>.zip` from
the latest GitHub release, checks the bundle id and the signature, installs to
`/Applications` (or `~/Applications` when that isn't writable), and opens it. A
Junior.app that's already there is quit and replaced, including the Chrome-shim
app the old `junior app install` wrote.

| env | does |
| --- | --- |
| `JUNIOR_VERSION=1.0.4` | install that version instead of the latest |
| `JUNIOR_APP_ZIP=path.zip` | install a local zip, e.g. from `npm run app:build` |
| `JUNIOR_INSTALL_DIR=dir` | install somewhere else |
| `JUNIOR_NO_OPEN=1` | don't open the app afterwards |

Needs macOS 12 or newer, and [Claude Code](https://claude.com/claude-code)
installed and logged in, same as the npm package.

## How it works

- **Attach, else start.** On launch the app asks `GET /api/health` on
  `localhost:5178`. If junior answers (an `npm i -g usejunior` daemon, a
  LaunchAgent, an earlier app launch), the window loads it. If nothing answers,
  it starts the daemon it bundles, detached, with `cli.js start`, the same path
  `junior start` takes, so an installed LaunchAgent is used when there is one.
  If something other than junior holds the port, the app says so and stops.
- **Quitting the app leaves junior running.** Live Claude sessions, terminals
  and jobs belong to the daemon, not the window. Restart it from
  *Junior › Restart junior server…* (or the menu bar icon). That ends live
  sessions, so the app asks first.
- **Bundled runtime.** `Contents/Resources/node` is an official Node 22 binary
  for the app's arch (`node:sqlite`, and the Agent SDK spawns `node` for Claude
  Code). `Contents/Resources/junior` is the `usejunior` package with its
  production `node_modules`. The app version is the root `package.json` version.
- **PATH.** An app opened from Finder gets `/usr/bin:/bin:/usr/sbin:/sbin`, where
  `claude`, `gh` and `git` don't resolve. The app reads `PATH` from your login
  shell once (`$SHELL -ilc`, 5 s timeout, then Homebrew and `~/.local/bin`
  defaults) and puts the bundled `node/bin` first.
- **Port and data.** `JUNIOR_APP_PORT` picks the port (default `5178`), and
  `JUNIOR_HOME` passes through unchanged (default `~/.junior`). Together they
  let you point the app at an isolated daemon without touching prod:

  ```sh
  JUNIOR_APP_PORT=5199 JUNIOR_HOME=/tmp/junior-app /Applications/Junior.app/Contents/MacOS/Junior
  ```

- **Local, no pairing.** The window loads `http://localhost:<port>/`. A loopback
  socket with a loopback `Host` counts as local in `server/remote.ts`.

## Develop

```sh
npm run build                 # at the repo root, once: the app runs ../dist/server/cli.js
cd desktop && npm install && npm start
```

Unpackaged, the app uses the system `node` and the repo's `dist/`. If a dev or
prod daemon is already on the port, it attaches to that one. To exercise the
start path, use a free port and a throwaway home:

```sh
JUNIOR_APP_PORT=5199 JUNIOR_HOME=/tmp/junior-app npm start
```

## Build

```sh
npm run app:build                   # at the repo root, for this Mac's arch
npm run app:build -- --arch x64     # or arm64
```

[`scripts/build.mjs`](scripts/build.mjs) runs the root build, stages the package
with production deps, fetches Node into `.cache/`, packs with electron-builder,
ad-hoc signs, and zips with `ditto`:
`desktop/release/Junior-<version>-mac-<arch>.zip`. Try it with the installer
before a release exists:

```sh
JUNIOR_APP_ZIP=desktop/release/Junior-1.0.4-mac-arm64.zip sh install.sh
```

Releases build both arches in CI ([`.github/workflows/desktop.yml`](../.github/workflows/desktop.yml)):
pushing a `v*` tag builds on macos-15 (arm64) and macos-15-intel (x64), waits
for `/release` to create the GitHub release, and uploads the zips to it. For a
tag that already has a release, run the workflow by hand with that tag.

## Signing

There's no Apple Developer ID yet, so the app is **ad-hoc signed**
(`codesign -s -`), not notarized. What that means in practice:

- `curl | sh` installs open without a Gatekeeper prompt: curl sets no
  quarantine attribute, and the installer strips it anyway.
- A zip downloaded **in a browser** gets quarantined, and macOS refuses the app
  ("cannot be opened" / "damaged"). Use the installer, or run
  `xattr -dr com.apple.quarantine /Applications/Junior.app`.
- There's no auto-update. Run the installer again to upgrade. If the daemon was
  started from the old app, it keeps running the old code until you restart it.
  The installer tells you when that's the case.
- Homebrew isn't an option: the official tap no longer takes unsigned casks.

## Uninstall

If the app started the daemon, stop it first: `junior stop`, or without the npm
package:

```sh
/Applications/Junior.app/Contents/Resources/node/bin/node \
  /Applications/Junior.app/Contents/Resources/junior/dist/server/cli.js stop
```

Then quit the app and remove it and its window state:

```sh
osascript -e 'quit app id "sh.usejunior.app"'
rm -rf /Applications/Junior.app ~/Library/Application\ Support/Junior
```

Your inbox, sessions and workspaces live in `~/.junior` and stay.

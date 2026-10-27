# Junior for iPhone

A native SwiftUI client for the Junior running on your Mac. It speaks the same WebSocket and HTTP API
as the browser (`shared/protocol/wire.ts`), so chats live on the Mac: one started here shows in the
browser, and the other way round. No server changes, no third-party packages.

- **Pair:** scan the QR code in the Mac's top-bar phone popover, or paste its link. The link
  (`<mac>/api/pair?token=...`) is kept in the Keychain; the token rides every request as
  `Authorization: Bearer`. A 401 sends the app back to the scanner.
- **Workspaces:** the pill at the top left switches; the socket and every request carry `?workspace=`.
- **Chats:** the list, a chat's newest page (older ones on request), live streaming, tool calls as one
  line each (tap for input and result), permission prompts, questions and plans to approve, photos,
  Stop. New chat: pick a project, write the first message.
- **Artifacts:** read-only. Markdown rendered, html/svg in a web view, images and PDFs as themselves.
- **Background:** iOS freezes the socket; coming back reconnects and the open chat re-subscribes.

| File | What |
|---|---|
| `Client.swift` | the connection: socket, reconnects, workspace switch, HTTP |
| `Transcript.swift` | the event log folded into rows (the essentials of `web/src/transcript.ts`) |
| `ChatsView` · `ChatView` · `PromptCard` · `Composer` | chats |
| `ArtifactsView` | artifacts |
| `MarkdownText` | block markdown, inline through Foundation's parser |
| `PairView` · `ScannerView` · `Pairing` | pairing and the Keychain |

## Run it

You need Xcode, signed in with your Apple ID (Settings → Accounts). Free signing lasts 7 days.

```sh
open ios/Junior.xcodeproj    # pick your iPhone, ⌘R
```

On the Mac: the phone icon in Junior's top bar → switch on → scan.

## Simulator

No camera there, and no taps from a script. Debug builds take launch arguments:

```sh
xcrun simctl launch booted sh.usejunior.junior.phone -pairLink "http://<mac-ip>:5178/api/pair?token=<token>"
xcrun simctl launch booted sh.usejunior.junior.phone -openChat <session-id>
xcrun simctl launch booted sh.usejunior.junior.phone -tab artifacts -openArtifact first
```

Build signed (`CODE_SIGN_IDENTITY=-`) so the Keychain works.

## Regenerate the project

`ios/project.yml` is the source. After changing it, or adding a Swift file: `cd ios && xcodegen generate`.

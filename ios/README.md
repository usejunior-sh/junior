# Junior for iPhone

A thin native shell around Junior's own web UI. The Mac runs Junior; this app is the window onto it.
It adds what a home-screen PWA cannot: a camera scan to pair, a saved pairing that survives iOS
dropping cookies, a full-screen web view with no Safari chrome and no pinch zoom, and a reload when
you come back after a while away (iOS freezes the socket while the app is in the background).

## Run it

You need Xcode. Free signing works, and the app expires after 7 days; a developer account lasts a year.

```sh
brew install xcodegen      # only to regenerate the project; the .xcodeproj is committed
open ios/Junior.xcodeproj
```

1. Select the **Junior** target, Signing & Capabilities, and pick your Team.
2. Plug in the iPhone, choose it as the run destination, press Run. Trust the developer profile on the
   phone (Settings → General → VPN & Device Management) the first time.
3. On the Mac, click the phone icon in Junior's top bar, switch **Allow other devices** on, and pick
   *Same Wi-Fi* or *Anywhere*. In dev, start Vite with `JUNIOR_DEV_LAN=1 npm run dev`.
4. Scan the QR code with the app. Allow Camera and Local Network when iOS asks.

## How it works

- The QR code is `<mac>/api/pair?token=...`. The app loads it in a `WKWebView`; the Mac answers with a
  cookie and a redirect to Junior (`server/phone.ts`).
- The link is kept in the Keychain. Every launch loads it again, so a dropped cookie re-pairs by itself.
- A 401 from the Mac (token reset, access switched off) sends the app back to the scanner.
- Links to other sites open in Safari. Two-finger long press: Reload, or Pair with another Mac.
- The page gets a `nativeShell` class on `<html>` and `JuniorApp/0.1` in its user agent, for CSS or code
  that must tell the app from a browser.

## Simulator

No camera there. Pair with a launch argument (debug builds only), from a signed build so the Keychain works:

```sh
xcrun simctl launch booted sh.usejunior.junior.phone -pairLink "http://<mac-ip>:5188/api/pair?token=<token>"
```

## Regenerate the project

`ios/project.yml` is the source. After changing it, or adding a Swift file: `cd ios && xcodegen generate`.

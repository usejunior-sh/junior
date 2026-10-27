import SwiftUI

struct RootView: View {
    @State private var link: URL? = RootView.launchLink() ?? Keychain.load()
    @State private var client: JuniorClient?
    @State private var notice: String?
    @Environment(\.scenePhase) private var phase

    var body: some View {
        ZStack {
            Theme.canvas.ignoresSafeArea()
            if let client {
                MainView(client: client, onForget: { forget(notice: nil) })
                    .onChange(of: client.unpaired) { _, gone in
                        if gone { forget(notice: "This phone is no longer paired. Scan the new QR code on your Mac.") }
                    }
            } else {
                PairView(notice: notice) { url in
                    Keychain.save(url)
                    notice = nil
                    link = url
                }
            }
        }
        .onAppear(perform: start)
        .onChange(of: link) { _, _ in start() }
        .onChange(of: phase) { _, now in
            if now == .active { client?.resume() }
        }
    }

    private func start() {
        client?.disconnect()
        client = link.flatMap { JuniorClient(link: $0) }
        client?.connect()
    }

    /// Drop the pairing: the saved link and the live connection.
    private func forget(notice message: String?) {
        Keychain.clear()
        client?.disconnect()
        client = nil
        notice = message
        link = nil
    }

    /// Debug builds only: `-pairLink <url>` as a launch argument pairs without a camera
    /// (the Simulator has none): `xcrun simctl launch <device> sh.usejunior.junior.phone -pairLink <url>`.
    private static func launchLink() -> URL? {
        #if DEBUG
        if let text = UserDefaults.standard.string(forKey: "pairLink"), let url = Pairing.parse(text) {
            Keychain.save(url)
            return url
        }
        #endif
        return nil
    }
}

struct MainView: View {
    let client: JuniorClient
    var onForget: () -> Void

    // `-tab artifacts` opens on Artifacts (debug builds), for checking the Simulator without taps.
    @State private var tab = UserDefaults.standard.string(forKey: "tab") ?? "chats"

    var body: some View {
        TabView(selection: $tab) {
            ChatsView(client: client, onForget: onForget)
                .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }
                .tag("chats")
            ArtifactsView(client: client, onForget: onForget)
                .tabItem { Label("Artifacts", systemImage: "doc.text") }
                .tag("artifacts")
        }
    }
}

/// The toolbar's workspace pill: which world you are in, and the way to the others.
struct WorkspaceMenu: View {
    let client: JuniorClient
    var onForget: () -> Void
    @State private var confirmForget = false

    var body: some View {
        Menu {
            ForEach(client.workspaces) { w in
                Button {
                    client.switchWorkspace(w.id)
                } label: {
                    if w.id == client.workspaceId { Label(w.name, systemImage: "checkmark") } else { Text(w.name) }
                }
            }
            Divider()
            Button("Reconnect", systemImage: "arrow.clockwise") { client.connect() }
            Button("Pair with another Mac", systemImage: "qrcode.viewfinder", role: .destructive) { confirmForget = true }
        } label: {
            HStack(spacing: 6) {
                Circle().fill(Color(css: client.workspace?.color ?? "")).frame(width: 7, height: 7)
                Text(client.workspace?.name ?? "Workspace").font(Theme.sans(14)).foregroundStyle(Theme.ink).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.ash)
            }
            .padding(.horizontal, 4)
        }
        .confirmationDialog("Forget this Mac and scan a new QR code?", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("Pair with another Mac", role: .destructive, action: onForget)
        }
    }
}

/// A thin line under the bar while the Mac can't be reached.
struct ConnBanner: View {
    let client: JuniorClient

    var body: some View {
        if client.conn != .connected {
            HStack(spacing: 8) {
                ProgressView().controlSize(.mini).tint(Theme.ash)
                Text(client.conn == .connecting ? "Connecting to your Mac…" : "Can’t reach your Mac. Retrying…")
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.mute)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .background(Theme.elev)
        }
    }
}

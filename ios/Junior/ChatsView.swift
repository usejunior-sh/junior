import SwiftUI

struct ChatsView: View {
    let client: JuniorClient
    var onForget: () -> Void
    @State private var path: [String] = []
    @State private var composing = false

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                ConnBanner(client: client)
                List {
                    ForEach(client.chats) { s in
                        NavigationLink(value: s.id) { ChatRow(session: s) }
                            .listRowBackground(Theme.canvas)
                            .listRowSeparatorTint(Theme.hair)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .overlay {
                    if client.chats.isEmpty && client.conn == .connected {
                        ContentUnavailableView("No chats yet", systemImage: "bubble.left", description: Text("Start one with the pencil, or on your Mac."))
                    }
                }
                .refreshable { client.connect() }
            }
            .background(Theme.canvas)
            .navigationTitle("Chats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { WorkspaceMenu(client: client, onForget: onForget) }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { composing = true } label: { Image(systemName: "square.and.pencil") }
                        .disabled(client.conn != .connected)
                }
            }
            .navigationDestination(for: String.self) { id in ChatView(client: client, sessionId: id) }
            .sheet(isPresented: $composing) { NewChatView(client: client) }
            .onChange(of: client.created) { _, id in
                guard let id else { return }
                client.created = nil
                path = [id]
            }
            .onChange(of: client.workspaceId) { _, _ in path = [] }
            #if DEBUG
            // `-openChat <id>`: open a chat at launch, for checking the Simulator without taps.
            .onAppear { if let id = UserDefaults.standard.string(forKey: "openChat"), path.isEmpty { path = [id] } }
            #endif
        }
    }
}

struct ChatRow: View {
    let session: SessionSummary

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            StatusMark(session: session).padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title)
                    .font(Theme.sans(15))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(2)
                HStack(spacing: 6) {
                    if session.pinned { Image(systemName: "pin.fill").font(.system(size: 9)) }
                    Text(session.folder).font(Theme.mono(11))
                    if session.waiting { Text("needs you").font(Theme.sans(11)).foregroundStyle(Theme.orange) }
                }
                .foregroundStyle(Theme.ash)
            }
            Spacer(minLength: 8)
            Text(session.updatedAt.ago).font(Theme.mono(11)).foregroundStyle(Theme.ash)
        }
        .padding(.vertical, 4)
    }
}

/// Orange only when it needs you; a pulse while it works; red when it failed.
struct StatusMark: View {
    let session: SessionSummary

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .opacity(session.running && !session.waiting ? 0.9 : 1)
    }

    private var color: Color {
        if session.waiting { return Theme.orange }
        if session.status == "error" { return Theme.red }
        if session.running { return Theme.blue }
        return Theme.stone
    }
}

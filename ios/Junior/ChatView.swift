import SwiftUI
import UIKit

struct ChatView: View {
    let client: JuniorClient
    let sessionId: String

    private var session: SessionSummary? { client.session(sessionId) }
    private var items: [TranscriptItem] { Transcript.fold(client.events[sessionId] ?? []) }

    var body: some View {
        let items = self.items
        let live = client.live[sessionId] ?? ""
        let running = session?.running ?? false
        VStack(spacing: 0) {
            ConnBanner(client: client)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if client.paging[sessionId]?.hasEarlier == true {
                            Button(client.paging[sessionId]?.loading == true ? "Loading…" : "Show earlier messages") {
                                client.loadEarlier(sessionId)
                            }
                            .font(Theme.sans(13))
                            .foregroundStyle(Theme.mute)
                            .frame(maxWidth: .infinity)
                        }
                        if client.events[sessionId] == nil {
                            ProgressView().tint(Theme.ash).frame(maxWidth: .infinity).padding(.top, 40)
                        }
                        ForEach(items) { item in
                            RowView(item: item, running: running) { request, behavior, answers in
                                client.respond(sessionId, request: request, behavior: behavior, answers: answers)
                            }
                            .id(item.id)
                        }
                        if !live.isEmpty {
                            MarkdownText(text: live).id("live")
                        } else if running, !(session?.waiting ?? false) {
                            WorkingLine().id("live")
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .defaultScrollAnchor(.bottom)
                .onChange(of: items.count) { _, _ in withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("end", anchor: .bottom) } }
                .onChange(of: live.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            }
            Composer(running: running, enabled: client.conn == .connected) { text, images in
                client.say(text, images: images, in: sessionId)
            } onStop: {
                client.interrupt(sessionId)
            }
        }
        .background(Theme.canvas)
        .navigationTitle(session?.title ?? "Chat")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .onAppear { client.open(sessionId) }
        .onDisappear { client.close(sessionId) }
    }
}

struct WorkingLine: View {
    @State private var on = false

    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(Theme.blue).frame(width: 6, height: 6).opacity(on ? 1 : 0.3)
            Text("Working…").font(Theme.sans(13)).foregroundStyle(Theme.ash)
        }
        .onAppear { withAnimation(.easeInOut(duration: 0.8).repeatForever()) { on = true } }
    }
}

struct RowView: View {
    let item: TranscriptItem
    let running: Bool
    var respond: (String, String, [String: String]?) -> Void

    var body: some View {
        switch item.row {
        case .user(let text, let images):
            UserBubble(text: text, images: images)
        case .assistant(let text):
            MarkdownText(text: text)
        case .tool(let call):
            ToolRow(call: call, running: running)
        case .prompt(let p):
            PromptCard(prompt: p, respond: respond)
        case .error(let text):
            Label(text, systemImage: "exclamationmark.triangle")
                .font(Theme.sans(13))
                .foregroundStyle(Theme.red)
        case .notice(let text):
            Text(text).font(Theme.sans(12)).foregroundStyle(Theme.ash)
        case .turnEnd(let text):
            Text(text).font(Theme.mono(11)).foregroundStyle(Theme.stone).frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
}

struct UserBubble: View {
    let text: String
    let images: [String]

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            if !images.isEmpty {
                HStack(spacing: 6) {
                    ForEach(Array(images.enumerated()), id: \.offset) { _, b64 in
                        if let data = Data(base64Encoded: b64), let img = UIImage(data: data) {
                            Image(uiImage: img).resizable().scaledToFill().frame(width: 72, height: 72).clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
            if !text.isEmpty {
                Text(text)
                    .font(Theme.sans(15))
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(Theme.elev)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 40)
    }
}

/// One tool call as one quiet line; tap to see what it sent and what came back.
struct ToolRow: View {
    let call: ToolCall
    let running: Bool
    @State private var open = false

    var body: some View {
        let s = Transcript.summary(call)
        VStack(alignment: .leading, spacing: 6) {
            Button { open.toggle() } label: {
                HStack(spacing: 7) {
                    if call.result == nil && running {
                        ProgressView().controlSize(.mini).tint(Theme.ash)
                    } else {
                        Image(systemName: call.isError ? "xmark.circle" : "checkmark")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(call.isError ? Theme.red : Theme.stone)
                    }
                    Text(s.label).font(Theme.sans(13)).foregroundStyle(Theme.mute)
                    Text(s.detail).font(Theme.mono(12)).foregroundStyle(Theme.ash).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    Text(call.input.pretty).font(Theme.mono(11)).foregroundStyle(Theme.mute)
                    if let r = call.result, !r.isEmpty {
                        Divider().overlay(Theme.hair)
                        Text(r.count > 4000 ? String(r.prefix(4000)) + "\n…" : r)
                            .font(Theme.mono(11))
                            .foregroundStyle(call.isError ? Theme.red : Theme.body)
                    }
                }
                .textSelection(.enabled)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.deep)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
        }
    }
}

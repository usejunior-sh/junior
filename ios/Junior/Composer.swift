import PhotosUI
import SwiftUI
import UIKit

/// The message box: text, photos, send; Stop while Junior works and the box is empty.
struct Composer: View {
    let running: Bool
    let enabled: Bool
    var placeholder = "Message Junior"
    var onSend: (String, [ImageAttachment]) -> Void
    var onStop: () -> Void = {}

    @State private var text = ""
    @State private var picks: [PhotosPickerItem] = []
    @State private var images: [ImageAttachment] = []
    @FocusState private var focused: Bool

    private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(Array(images.enumerated()), id: \.offset) { i, a in
                            if let d = Data(base64Encoded: a.data), let img = UIImage(data: d) {
                                Image(uiImage: img).resizable().scaledToFill().frame(width: 56, height: 56)
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                                    .overlay(alignment: .topTrailing) {
                                        Button { images.remove(at: i) } label: {
                                            Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.ink, Theme.canvas)
                                        }
                                        .offset(x: 4, y: -4)
                                    }
                            }
                        }
                    }
                    .padding(.top, 4)
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                PhotosPicker(selection: $picks, maxSelectionCount: 4, matching: .images) {
                    Image(systemName: "plus").font(.system(size: 17)).foregroundStyle(Theme.mute).frame(width: 30, height: 34)
                }
                .accessibilityLabel("Attach photos")
                TextField(placeholder, text: $text, axis: .vertical)
                    .font(Theme.sans(15))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.vertical, 7)
                if running && empty {
                    Button(action: onStop) {
                        Image(systemName: "stop.fill").font(.system(size: 12)).foregroundStyle(Theme.canvas)
                            .frame(width: 32, height: 32).background(Theme.ink).clipShape(Circle())
                    }
                    .accessibilityLabel("Stop")
                } else {
                    Button {
                        onSend(text.trimmingCharacters(in: .whitespacesAndNewlines), images)
                        text = ""
                        images = []
                    } label: {
                        Image(systemName: "arrow.up").font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.canvas)
                            .frame(width: 32, height: 32).background(empty || !enabled ? Theme.stone : Theme.ink).clipShape(Circle())
                    }
                    .disabled(empty || !enabled)
                    .accessibilityLabel("Send")
                }
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.elev)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Theme.hairStrong, lineWidth: 1))
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
        .padding(.top, 4)
        .background(Theme.canvas)
        .onChange(of: picks) { _, items in
            guard !items.isEmpty else { return }
            Task {
                for item in items {
                    if let data = try? await item.loadTransferable(type: Data.self), let a = Composer.attachment(data) {
                        images.append(a)
                    }
                }
                picks = []
            }
        }
    }

    /// A photo as the wire wants it: JPEG, at most 1600px on its long side, well under the 4 MB cap.
    static func attachment(_ data: Data) -> ImageAttachment? {
        guard let img = UIImage(data: data) else { return nil }
        let side = max(img.size.width, img.size.height)
        let scale = side > 1600 ? 1600 / side : 1
        let size = CGSize(width: img.size.width * scale, height: img.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let out = UIGraphicsImageRenderer(size: size, format: format).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        guard let jpeg = out.jpegData(compressionQuality: 0.8) else { return nil }
        return ImageAttachment(mediaType: "image/jpeg", data: jpeg.base64EncodedString())
    }
}

/// A new chat: which project it runs in, and the first message.
struct NewChatView: View {
    let client: JuniorClient
    @Environment(\.dismiss) private var dismiss
    @State private var projectId: String?

    private var project: Project? {
        client.projects.first { $0.id == projectId } ?? client.projects.first(where: \.isDefault) ?? client.projects.first
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("What should Junior do?")
                    .font(Theme.serif(34))
                    .foregroundStyle(Theme.ink)
                Menu {
                    ForEach(client.projects) { p in
                        Button {
                            projectId = p.id
                        } label: {
                            if p.id == project?.id { Label(p.name, systemImage: "checkmark") } else { Text(p.name) }
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "folder").font(.system(size: 12))
                        Text(project?.name ?? "No projects on your Mac").font(Theme.mono(13))
                        Image(systemName: "chevron.down").font(.system(size: 10))
                    }
                    .foregroundStyle(Theme.mute)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .overlay(Capsule().stroke(Theme.hairStrong, lineWidth: 1))
                }
                .disabled(client.projects.isEmpty)
                Spacer()
                Composer(running: false, enabled: project != nil && client.conn == .connected, placeholder: "Hand me something, or ask me anything…") { text, images in
                    guard let project else { return }
                    client.createChat(in: project, text: text, images: images)
                    dismiss()
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .background(Theme.canvas)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Cancel") { dismiss() } }
            }
            .task { if client.projects.isEmpty { await client.loadProjects() } }
        }
        .presentationBackground(Theme.canvas)
    }
}

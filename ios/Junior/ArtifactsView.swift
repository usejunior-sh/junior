import PDFKit
import SwiftUI
import WebKit

struct ArtifactsView: View {
    let client: JuniorClient
    var onForget: () -> Void
    @State private var list: [Artifact] = []
    @State private var error: String?
    @State private var loaded = false
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                ConnBanner(client: client)
                List {
                    ForEach(list) { a in
                        NavigationLink(value: a.id) { ArtifactRow(artifact: a) }
                            .listRowBackground(Theme.canvas)
                            .listRowSeparatorTint(Theme.hair)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .overlay {
                    if let error {
                        ContentUnavailableView("Couldn’t load artifacts", systemImage: "exclamationmark.triangle", description: Text(error))
                    } else if loaded && list.isEmpty {
                        ContentUnavailableView("No artifacts yet", systemImage: "doc.text", description: Text("Notes, reports and pages Junior writes show up here."))
                    } else if !loaded {
                        ProgressView().tint(Theme.ash)
                    }
                }
                .refreshable { await load() }
            }
            .background(Theme.canvas)
            .navigationTitle("Artifacts")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .topBarLeading) { WorkspaceMenu(client: client, onForget: onForget) } }
            .navigationDestination(for: String.self) { id in
                ArtifactView(client: client, artifact: list.first { $0.id == id })
            }
            .task(id: "\(client.artifactsVersion):\(client.workspaceId ?? "")") { await load() }
            .onChange(of: client.workspaceId) { _, _ in path = [] }
        }
    }

    private func load() async {
        do {
            list = try await client.artifacts()
            #if DEBUG
            // `-openArtifact first`: open the newest one at launch, for checking the Simulator without taps.
            if UserDefaults.standard.string(forKey: "openArtifact") != nil, path.isEmpty, let first = list.first { path = [first.id] }
            #endif
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }
}

struct ArtifactRow: View {
    let artifact: Artifact

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Text(artifact.format.uppercased())
                .font(Theme.mono(9))
                .foregroundStyle(Theme.ash)
                .frame(width: 34, height: 18)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(Theme.hairStrong, lineWidth: 1))
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(artifact.title).font(Theme.sans(15)).foregroundStyle(Theme.ink).lineLimit(2)
                Text(artifact.author == "human" ? "You" : "Junior").font(Theme.sans(12)).foregroundStyle(Theme.ash)
            }
            Spacer(minLength: 8)
            Text(artifact.updated.ago).font(Theme.mono(11)).foregroundStyle(Theme.ash)
        }
        .padding(.vertical, 4)
    }
}

/// One artifact, read-only: markdown rendered, pages in a web view, images and PDFs as themselves.
struct ArtifactView: View {
    let client: JuniorClient
    let artifact: Artifact?
    @State private var text: String?
    @State private var bytes: Data?
    @State private var error: String?

    var body: some View {
        Group {
            if let error {
                ContentUnavailableView("Couldn’t open it", systemImage: "exclamationmark.triangle", description: Text(error))
            } else if let artifact {
                content(artifact)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.canvas)
        .navigationTitle(artifact?.title ?? "Artifact")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .task(id: "\(artifact?.id ?? ""):\(client.artifactsVersion)") { await load() }
    }

    @ViewBuilder
    private func content(_ a: Artifact) -> some View {
        switch a.format {
        case "md":
            if let text {
                ScrollView { MarkdownText(text: text).padding(16) }
            } else { loading }
        case "html", "svg":
            if let text { HTMLView(html: text) } else { loading }
        case "pdf":
            if let bytes { PDFViewer(data: bytes) } else { loading }
        case "png", "jpg", "gif", "webp":
            if let bytes, let img = UIImage(data: bytes) {
                ScrollView { Image(uiImage: img).resizable().scaledToFit().frame(maxWidth: .infinity) }
            } else { loading }
        default:
            if let text {
                ScrollView([.vertical, .horizontal]) {
                    Text(text).font(Theme.mono(12)).foregroundStyle(Theme.body).textSelection(.enabled).padding(16)
                }
            } else { loading }
        }
    }

    private var loading: some View { ProgressView().tint(Theme.ash).frame(maxWidth: .infinity, maxHeight: .infinity) }

    private func load() async {
        guard let a = artifact else { return }
        do {
            if a.isImage || a.format == "pdf" {
                bytes = try await client.get("/api/artifacts/raw", ["id": a.id])
            } else {
                let j = try await client.getJSON("/api/artifacts/content", ["id": a.id])
                if j["ok"]?.bool == false { throw ClientError.http(404, j["error"]?.string ?? "") }
                text = j["body"]?.string ?? ""
            }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct HTMLView: UIViewRepresentable {
    let html: String

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(Theme.canvas)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        guard context.coordinator.loaded != html else { return }
        context.coordinator.loaded = html
        let page = html.contains("name=\"viewport\"") ? html : "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">" + html
        web.loadHTMLString(page, baseURL: nil)
    }

    func makeCoordinator() -> Coordinator { Coordinator() }
    final class Coordinator { var loaded: String? }
}

struct PDFViewer: UIViewRepresentable {
    let data: Data

    func makeUIView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.backgroundColor = UIColor(Theme.canvas)
        v.document = PDFDocument(data: data)
        return v
    }

    func updateUIView(_ v: PDFView, context: Context) {}
}

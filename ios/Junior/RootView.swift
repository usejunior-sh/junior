import SwiftUI
import WebKit

struct RootView: View {
    @State private var link: URL? = RootView.launchLink() ?? Keychain.load()
    @State private var notice: String?
    @StateObject private var model = ShellModel()

    var body: some View {
        ZStack {
            Color("Canvas").ignoresSafeArea()
            if let link {
                ShellView(link: link, model: model, onUnpaired: {
                    forget(notice: "This phone is no longer paired. Scan the new QR code on your Mac.")
                })
                .ignoresSafeArea()
                if let failure = model.failure {
                    FailureView(message: failure, onRetry: { model.reload() }, onRepair: { forget(notice: nil) })
                }
            } else {
                PairView(notice: notice) { url in
                    Keychain.save(url)
                    notice = nil
                    link = url
                }
            }
        }
        .confirmationDialog("Junior", isPresented: $model.showMenu, titleVisibility: .hidden) {
            Button("Reload") { model.reload() }
            Button("Pair with another Mac", role: .destructive) { forget(notice: nil) }
            Button("Cancel", role: .cancel) {}
        }
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

    /// Drop the pairing: the saved link, and the cookie the Mac gave this phone.
    private func forget(notice message: String?) {
        Keychain.clear()
        let store = WKWebsiteDataStore.default()
        store.fetchDataRecords(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes()) { records in
            store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), for: records) {}
        }
        model.failure = nil
        notice = message
        link = nil
    }
}

private struct FailureView: View {
    var message: String
    var onRetry: () -> Void
    var onRepair: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Text(message)
                .font(.system(size: 15))
                .foregroundColor(Color(white: 0.75))
                .multilineTextAlignment(.center)
            HStack(spacing: 12) {
                Button("Try again", action: onRetry).buttonStyle(.borderedProminent)
                Button("Pair again", action: onRepair).buttonStyle(.bordered)
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color("Canvas"))
    }
}

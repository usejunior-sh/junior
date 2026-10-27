import SwiftUI
import UIKit
import WebKit

/// What the SwiftUI side needs to know about, and tell, the web view.
final class ShellModel: ObservableObject {
    @Published var failure: String?
    @Published var showMenu = false
    weak var web: WKWebView?
    var link: URL?

    func reload() {
        failure = nil
        if let web, web.url != nil {
            web.reload()
        } else if let link {
            web?.load(URLRequest(url: link))
        }
    }
}

/// Junior's own web UI, full screen, served by the copy of Junior on the Mac.
struct ShellView: UIViewRepresentable {
    let link: URL
    @ObservedObject var model: ShellModel
    var onUnpaired: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(model: model, onUnpaired: onUnpaired) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.allowsInlineMediaPlayback = true
        config.applicationNameForUserAgent = "JuniorApp/0.1"
        let scripts = WKUserContentController()
        scripts.addUserScript(WKUserScript(source: Coordinator.script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController = scripts

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = UIColor(named: "Canvas")
        web.scrollView.backgroundColor = UIColor(named: "Canvas")
        // The page draws under the status bar and home indicator itself (env(safe-area-inset-*)).
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.bounces = false
        web.scrollView.keyboardDismissMode = .interactive
        web.scrollView.pinchGestureRecognizer?.isEnabled = false
        web.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { web.isInspectable = true }

        let press = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.twoFingerPress(_:)))
        press.numberOfTouchesRequired = 2
        press.minimumPressDuration = 0.8
        press.cancelsTouchesInView = false
        press.delegate = context.coordinator
        web.addGestureRecognizer(press)

        model.web = web
        model.link = link
        context.coordinator.load(link, in: web)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        model.link = link
        context.coordinator.load(link, in: web)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, UIGestureRecognizerDelegate {
        static let script = """
        try { document.documentElement.classList.add('nativeShell'); } catch (e) {}
        document.addEventListener('DOMContentLoaded', function () {
          var m = document.querySelector('meta[name=viewport]');
          if (m && m.content.indexOf('maximum-scale') < 0) m.content += ', maximum-scale=1, user-scalable=no';
        });
        """

        let model: ShellModel
        let onUnpaired: () -> Void
        private var loaded: URL?
        private var backgroundedAt: Date?

        init(model: ShellModel, onUnpaired: @escaping () -> Void) {
            self.model = model
            self.onUnpaired = onUnpaired
            super.init()
            let center = NotificationCenter.default
            center.addObserver(self, selector: #selector(resigned), name: UIApplication.willResignActiveNotification, object: nil)
            center.addObserver(self, selector: #selector(became), name: UIApplication.didBecomeActiveNotification, object: nil)
        }

        func load(_ link: URL, in web: WKWebView) {
            guard loaded != link else { return }
            loaded = link
            var request = URLRequest(url: link)
            // ngrok's one-time "Visit Site" page, skipped for the first request.
            request.setValue("true", forHTTPHeaderField: "ngrok-skip-browser-warning")
            web.load(request)
        }

        // iOS freezes the socket while the app is away. After a long absence, start the
        // page fresh: the event log restores the chat, and nothing waits on a dead socket.
        @objc private func resigned() { backgroundedAt = Date() }
        @objc private func became() {
            defer { backgroundedAt = nil }
            guard let at = backgroundedAt, Date().timeIntervalSince(at) > 60, let web = model.web, web.url != nil else { return }
            web.reload()
        }

        @objc func twoFingerPress(_ g: UILongPressGestureRecognizer) {
            if g.state == .began {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                model.showMenu = true
            }
        }

        func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        func webView(_ web: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = action.request.url, let base = model.link else { return decisionHandler(.allow) }
            let isHTTP = url.scheme == "http" || url.scheme == "https"
            if isHTTP && Pairing.sameServer(url, base) { return decisionHandler(.allow) }
            if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return decisionHandler(.allow) }
            // A link to anywhere else belongs in Safari, not in Junior's window.
            if action.targetFrame?.isMainFrame ?? true {
                UIApplication.shared.open(url)
                return decisionHandler(.cancel)
            }
            decisionHandler(.allow)
        }

        func webView(_ web: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            // The Mac answers an unpaired device with 401: the token was reset, or access is off.
            if response.isForMainFrame, let http = response.response as? HTTPURLResponse, http.statusCode == 401 {
                decisionHandler(.cancel)
                DispatchQueue.main.async { self.onUnpaired() }
                return
            }
            decisionHandler(.allow)
        }

        func webView(_ web: WKWebView, didFinish navigation: WKNavigation!) {
            if model.failure != nil { model.failure = nil }
        }

        func webView(_ web: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error) }
        func webView(_ web: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error) }

        private func fail(_ error: Error) {
            let e = error as NSError
            // Cancelled by us (a 401, a link sent to Safari) or replaced by a newer load: not a failure.
            if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
            if e.domain == "WebKitErrorDomain" && e.code == 102 { return }
            model.failure = "Can’t reach your Mac. Is Junior running there, with phone access on and the Mac awake?"
        }

        // window.open and target=_blank: same server stays in this window, the rest goes to Safari.
        func webView(_ web: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            guard let url = action.request.url else { return nil }
            if let base = model.link, Pairing.sameServer(url, base) {
                web.load(action.request)
            } else {
                UIApplication.shared.open(url)
            }
            return nil
        }
    }
}

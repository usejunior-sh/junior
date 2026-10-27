import Foundation
import Security

/// The pairing link the Mac's QR code carries: `<base>/api/pair?token=...`.
/// Loading it in the web view trades the token for a cookie, then lands on Junior.
enum Pairing {
    static func parse(_ raw: String) -> URL? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: text),
              let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              url.host != nil,
              url.path == "/api/pair",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
              items.contains(where: { $0.name == "token" && !($0.value ?? "").isEmpty })
        else { return nil }
        return url
    }

    /// Same server: host and port match. Anything else opens in Safari.
    static func sameServer(_ a: URL, _ b: URL) -> Bool {
        a.host?.lowercased() == b.host?.lowercased() && a.port == b.port
    }
}

/// The pairing link outlives the web view's cookie: if iOS drops the cookie, the
/// next launch pairs again from here without a new scan.
enum Keychain {
    private static let service = "sh.usejunior.junior.phone"
    private static let account = "pair-link"

    private static var base: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    static func load() -> URL? {
        var query = base
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data, let text = String(data: data, encoding: .utf8)
        else { return nil }
        return Pairing.parse(text)
    }

    static func save(_ url: URL) {
        clear()
        var query = base
        query[kSecValueData as String] = Data(url.absoluteString.utf8)
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(query as CFDictionary, nil)
    }

    static func clear() {
        SecItemDelete(base as CFDictionary)
    }
}

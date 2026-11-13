import Foundation
import Security

/// Secrets live in the iPhone's Keychain (this app's own entries, separate from Post Library's).
enum Keychain {
    static func load(_ account: String) -> String {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return "" }
        return String(decoding: d, as: UTF8.self)
    }
    static func save(_ account: String, _ value: String) {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account]
        SecItemDelete(base as CFDictionary)
        guard !value.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
    /// The iHatePosting API key for the Chaosity Vault account (not the main one).
    static var apiKey: String { get { load("ihateposting-chaosityvault") } set { save("ihateposting-chaosityvault", newValue) } }
}

struct Local: Codable, Hashable { let date: String; let time: String }
struct Target: Codable, Hashable {
    let platform: String
    let status: String?
    let externalUrl: String?
    let error: String?
    let socialAccountId: String?
}
struct Post: Codable, Identifiable, Hashable {
    let id: String
    let baseContent: String
    let status: String
    let scheduledAt: String?
    let publishedAt: String?
    let targets: [Target]
    let scheduledLocal: Local?
    var platform: String { targets.first?.platform ?? "" }
    var errorText: String? { targets.compactMap(\.error).first }
    var link: URL? { targets.compactMap(\.externalUrl).first.flatMap(URL.init(string:)) }
    var date: Date? {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let s = publishedAt ?? scheduledAt ?? ""
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }
}
struct Account: Codable, Identifiable, Hashable { let id: String; let platform: String; let handle: String; let displayName: String?; let status: String? }

struct APIError: LocalizedError { let message: String; var errorDescription: String? { message } }

enum API {
    static let base = URL(string: "https://ihateposting.com")!

    private static func request(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> Data {
        let key = Keychain.apiKey
        guard !key.isEmpty else { throw APIError(message: "Add the Chaosity Vault iHatePosting key in Settings (or connect your hub).") }
        guard let url = URL(string: path, relativeTo: base) else { throw APIError(message: "Bad request") }
        var r = URLRequest(url: url)
        r.httpMethod = method
        r.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { r.httpBody = try JSONSerialization.data(withJSONObject: body) }
        for attempt in 0..<3 {
            let (data, resp) = try await URLSession.shared.data(for: r)
            let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if code == 429, attempt < 2 { try await Task.sleep(for: .seconds(20)); continue }
            guard (200..<300).contains(code) else {
                let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                throw APIError(message: (j?["error"] as? String) ?? "iHatePosting returned HTTP \(code)")
            }
            return data
        }
        throw APIError(message: "iHatePosting is busy, try again in a minute.")
    }

    private struct PostsPage: Codable { let posts: [Post]; let hasMore: Bool?; let nextCursor: String? }
    static func posts(status: String, from: String? = nil) async throws -> [Post] {
        var out: [Post] = []
        var cursor: String?
        repeat {
            var c = URLComponents()
            c.path = "/api/v1/posts"
            var items = [URLQueryItem(name: "limit", value: "200"), URLQueryItem(name: "status", value: status)]
            if let from { items.append(URLQueryItem(name: "from", value: from)) }
            if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
            c.queryItems = items
            let page = try JSONDecoder().decode(PostsPage.self, from: try await request("GET", c.string ?? "/api/v1/posts"))
            out += page.posts
            cursor = page.hasMore == true ? page.nextCursor : nil
        } while cursor != nil
        return out
    }

    private struct AccountsPage: Codable { let accounts: [Account] }
    static func accounts() async throws -> [Account] {
        try JSONDecoder().decode(AccountsPage.self, from: try await request("GET", "/api/v1/accounts")).accounts
    }
    static func deletePost(_ id: String) async throws { _ = try await request("DELETE", "/api/v1/posts/\(id)") }
    static func retry(_ id: String) async throws { _ = try await request("POST", "/api/v1/posts/\(id)/retry", body: [:]) }
}

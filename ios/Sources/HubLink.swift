import Foundation
import CryptoKit
import CommonCrypto

/// Your hub (api.briangopaul.com), project "chaosityvault". The PC app publishes its status, linked accounts and clip queue
/// there and picks up "auto on/off" and "run now" requests from this phone. The iHatePosting key for this channel comes
/// from your vault ("ihateposting_chaosityvault"), locked with your passphrase (same format as Post Library / Comment Helper).
enum HubLink {
    static let base = "https://api.briangopaul.com"
    static let project = "chaosityvault"
    static let vaultName = "ihateposting_chaosityvault"

    static var deviceKey: String { get { Keychain.load("cv-hub-device") } set { Keychain.save("cv-hub-device", newValue) } }
    static var passphrase: String { get { Keychain.load("cv-hub-vault") } set { Keychain.save("cv-hub-vault", newValue) } }
    static var isSet: Bool { !deviceKey.isEmpty }

    struct HubError: LocalizedError { let message: String; var status = 0; var errorDescription: String? { message } }

    static func request(_ method: String, _ path: String, json: Any? = nil, key: String? = nil) async throws -> Data {
        var r = URLRequest(url: URL(string: base + path)!, timeoutInterval: 30)
        r.httpMethod = method
        r.setValue("Bearer " + (key ?? deviceKey), forHTTPHeaderField: "Authorization")
        if let json {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        let data: Data, resp: URLResponse
        do { (data, resp) = try await URLSession.shared.data(for: r) }
        catch { throw HubError(message: "Couldn't reach your hub. Check your internet.") }
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else {
            var msg = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String ?? "Hub error \(code)."
            if code == 401 { msg = "The hub didn't accept this device key: " + msg }
            if code == 403 { msg = "This device key isn't for Chaosity Vault. On the hub page, make a key for chaosityvault with \"Can unlock my saved keys\" ticked." }
            throw HubError(message: msg, status: code)
        }
        return data
    }

    static func doc(_ coll: String, _ id: String) async throws -> Data? {
        do {
            let d = try await request("GET", "/v1/\(project)/docs/\(coll)/\(id)")
            guard let obj = try JSONSerialization.jsonObject(with: d) as? [String: Any], let data = obj["data"], !(data is NSNull) else { return nil }
            return try JSONSerialization.data(withJSONObject: data)
        } catch let e as HubError where e.status == 404 { return nil }
    }

    // MARK: What the PC publishes

    struct Uploader: Codable { let auto: Bool; let status: String; let lastTick: Double?; let lastError: String?; let stopReason: String?; let signIn: Bool; let hasKey: Bool?; let recent: [String] }
    struct PCAccount: Codable, Hashable { let id: String; let platform: String; let label: String; let cap: Int; let on: Bool }
    struct When: Codable, Hashable { let date: String; let min: Int; var text: String { String(format: "%@ %d:%02d", date, min / 60, min % 60) } }
    struct QueueItem: Codable, Hashable, Identifiable { let file: String; let title: String; let game: String; let dur: Double; let status: String; let sched: [String: When]?; var id: String { file } }
    private struct Beat: Codable { let at: Double }
    private struct Accounts: Codable { let accounts: [PCAccount] }
    private struct Queue: Codable { let items: [QueueItem] }

    static func pcOnline() async throws -> Bool {
        guard let b = try await doc("pc", "status").flatMap({ try? JSONDecoder().decode(Beat.self, from: $0) }) else { return false }
        return Date().timeIntervalSince1970 * 1000 - b.at < 150_000
    }
    /// Collabs (@ChaosityYouTube on Vault shorts), as the PC's collab.js last reported them (Nov 13 2026).
    struct Collab: Codable { let enabled: Bool; let done: Int; let pending: Int; let running: Bool; let last: String; let pendingTitles: [String]? }
    static func collab() async throws -> Collab? { try await doc("pc", "collab").flatMap { try? JSONDecoder().decode(Collab.self, from: $0) } }
    static func uploader() async throws -> Uploader? { try await doc("pc", "uploader").flatMap { try? JSONDecoder().decode(Uploader.self, from: $0) } }
    static func accounts() async throws -> [PCAccount] { try await doc("pc", "accounts").flatMap { try? JSONDecoder().decode(Accounts.self, from: $0) }?.accounts ?? [] }
    static func queue() async throws -> [QueueItem] { try await doc("queue", "_list").flatMap { try? JSONDecoder().decode(Queue.self, from: $0) }?.items ?? [] }

    /// Leaves a request for the PC (auto / runNow) and waits for its answer.
    static func ask(_ method: String, arg: [String: Any] = [:], wait: TimeInterval = 60) async throws {
        let rid = UUID().uuidString.lowercased()
        let body: [String: Any] = ["data": ["method": method, "id": "", "arg": arg, "state": "new", "at": Date().timeIntervalSince1970 * 1000]]
        _ = try await request("PUT", "/v1/\(project)/docs/requests/\(rid)", json: body)
        let until = Date().addingTimeInterval(wait)
        while Date() < until {
            try await Task.sleep(nanoseconds: 2_000_000_000)
            guard let d = try await doc("requests", rid), let obj = try JSONSerialization.jsonObject(with: d) as? [String: Any] else { continue }
            switch obj["state"] as? String {
            case "done": return
            case "failed": throw HubError(message: obj["error"] as? String ?? "Your PC couldn't do that.")
            default: continue
            }
        }
        throw HubError(message: "Your PC didn't answer. It has to be on with Chaosity Vault running.")
    }

    // MARK: Vault (read only on the phone)

    private static func derive(_ pass: String, salt: Data, rounds: Int) -> SymmetricKey {
        var out = [UInt8](repeating: 0, count: 32)
        let pw = Array(pass.utf8)
        _ = salt.withUnsafeBytes { s in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pw.map { Int8(bitPattern: $0) }, pw.count,
                                 s.bindMemory(to: UInt8.self).baseAddress, salt.count,
                                 CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), UInt32(rounds), &out, out.count)
        }
        return SymmetricKey(data: out)
    }
    static func readVault(_ pass: String) async throws -> [String: String]? {
        let box: [String: Any]?
        do {
            let raw = try await request("GET", "/v1/vault/docs/secrets/main")
            box = (try JSONSerialization.jsonObject(with: raw) as? [String: Any])?["data"] as? [String: Any]
        } catch let e as HubError where e.status == 404 { return nil }
        guard let d = box else { return nil }
        guard let salt = Data(base64Encoded: d["salt"] as? String ?? ""), let nonce = Data(base64Encoded: d["nonce"] as? String ?? ""),
              let ct = Data(base64Encoded: d["ct"] as? String ?? ""), let tag = Data(base64Encoded: d["tag"] as? String ?? "") else {
            throw HubError(message: "The vault looks damaged.")
        }
        do {
            let sealed = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: ct, tag: tag)
            let plain = try AES.GCM.open(sealed, using: derive(pass, salt: salt, rounds: d["iter"] as? Int ?? 210_000))
            return (try JSONSerialization.jsonObject(with: plain) as? [String: String]) ?? [:]
        } catch { throw HubError(message: "Wrong vault passphrase.") }
    }

    /// Checks the key and passphrase, saves them, and takes this channel's iHatePosting key from the vault.
    static func connect(key: String, pass: String) async throws -> String {
        var name = "this iPhone"
        let k = key.trimmingCharacters(in: .whitespacesAndNewlines)
        if !k.isEmpty {
            let d = try await request("GET", "/v1/ping", key: k)
            name = ((try? JSONSerialization.jsonObject(with: d)) as? [String: Any])?["device"] as? String ?? name
            deviceKey = k
        } else if !isSet { throw HubError(message: "Paste the device key from your hub page first.") }
        var got = false
        let p = pass.isEmpty ? passphrase : pass
        if !p.isEmpty {
            let v = try await readVault(p)
            passphrase = p
            if let ih = v?[vaultName], !ih.isEmpty, ih != Keychain.apiKey { Keychain.apiKey = ih; got = true }
        }
        return "Connected as \"\(name)\"." + (got ? " Got the Chaosity Vault iHatePosting key from your vault." : "")
    }
}

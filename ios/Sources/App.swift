import SwiftUI

@main
struct ChaosityVaultApp: App {
    var body: some Scene {
        WindowGroup {
            TabView {
                ScheduleView().tabItem { Label("Schedule", systemImage: "calendar") }
                ClipsView().tabItem { Label("Clips", systemImage: "film.stack") }
                PCView().tabItem { Label("PC", systemImage: "desktopcomputer") }
                SettingsView().tabItem { Label("Settings", systemImage: "gearshape") }
            }
            .tint(Color(red: 1, green: 0.16, blue: 0.23))
            .preferredColorScheme(.dark)
        }
    }
}

// MARK: Schedule (straight from iHatePosting with this channel's key)

struct ScheduleView: View {
    enum Tab: String, CaseIterable { case upcoming = "Upcoming", published = "Published", failed = "Failed" }
    @State private var tab: Tab = .upcoming
    @State private var posts: [Tab: [Post]] = [:]
    @State private var names: [String: String] = [:]
    @State private var error: String?
    @State private var loading = false

    var body: some View {
        NavigationStack {
            List {
                Picker("", selection: $tab) { ForEach(Tab.allCases, id: \.self) { Text("\($0.rawValue) (\(posts[$0]?.count ?? 0))").tag($0) } }
                    .pickerStyle(.segmented).listRowBackground(Color.clear)
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                let rows = posts[tab] ?? []
                if rows.isEmpty && !loading && error == nil {
                    Text(tab == .upcoming ? "Nothing scheduled right now." : tab == .failed ? "No failed posts." : "Nothing published in the last 7 days.").foregroundStyle(.secondary)
                }
                ForEach(rows) { p in PostRow(post: p, account: account(p), tab: tab, reload: { await load() }) }
            }
            .navigationTitle("Chaosity Vault")
            .refreshable { await load() }
            .task { await load() }
            .overlay { if loading && posts.isEmpty { ProgressView() } }
        }
    }

    private func account(_ p: Post) -> String {
        if let id = p.targets.first?.socialAccountId, let n = names[id] { return n }
        return p.platform == "youtube" ? "YouTube" : p.platform == "tiktok" ? "TikTok" : p.platform
    }

    private func load() async {
        loading = true; defer { loading = false }
        do {
            let from = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-7 * 86400)).prefix(10)
            async let up = API.posts(status: "scheduled")
            async let pub = API.posts(status: "published", from: String(from))
            async let bad = API.posts(status: "failed")
            async let acc = API.accounts()
            let (u, p, f, a) = try await (up, pub, bad, acc)
            names = Dictionary(a.map { ($0.id, "\($0.platform == "youtube" ? "YouTube" : "TikTok") \($0.displayName ?? $0.handle)") }, uniquingKeysWith: { x, _ in x })
            posts = [.upcoming: u.sorted { ($0.date ?? .distantFuture) < ($1.date ?? .distantFuture) },
                     .published: p.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) },
                     .failed: f.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }]
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

struct PostRow: View {
    let post: Post
    let account: String
    let tab: ScheduleView.Tab
    let reload: () async -> Void
    @State private var busy = false
    @State private var confirmCancel = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(post.date.map { $0.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().hour().minute()) } ?? "").font(.subheadline.bold())
                Spacer()
                Text(account).font(.caption).foregroundStyle(.secondary)
            }
            Text(post.baseContent).font(.subheadline).lineLimit(2)
            if let e = post.errorText ?? error { Text(e).font(.caption).foregroundStyle(.red) }
            HStack {
                if tab == .upcoming { Button("Cancel post", role: .destructive) { confirmCancel = true }.disabled(busy) }
                if tab == .failed { Button(busy ? "Retrying..." : "Retry") { run { try await API.retry(post.id) } }.disabled(busy) }
                if tab == .published, let link = post.link { Link("Open", destination: link) }
            }.font(.caption).buttonStyle(.bordered)
        }
        .confirmationDialog("Cancel this scheduled post? It won't go out.", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Cancel post", role: .destructive) { run { try await API.deletePost(post.id) } }
        }
    }
    private func run(_ f: @escaping () async throws -> Void) {
        busy = true
        Task { defer { busy = false }; do { try await f(); await reload() } catch { self.error = error.localizedDescription } }
    }
}

// MARK: Clips (the PC's queue, through the hub)

struct ClipsView: View {
    @State private var items: [HubLink.QueueItem] = []
    @State private var error: String?
    var body: some View {
        NavigationStack {
            List {
                if !HubLink.isSet { Text("Connect your hub in Settings to see the clip queue from your PC.").foregroundStyle(.secondary) }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                let waiting = items.filter { $0.status != "posted" }
                if HubLink.isSet && waiting.isEmpty && error == nil { Text("No clips waiting. Add shorts to Edited\\Chaosity Vault Uploads on your PC.").foregroundStyle(.secondary) }
                ForEach(waiting) { i in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(i.title).font(.subheadline.bold())
                        Text("\(i.game) · \(Int(i.dur)) s · \(label(i.status))").font(.caption).foregroundStyle(.secondary)
                        if let s = i.sched, !s.isEmpty { Text("Next: " + s.values.map(\.text).sorted().joined(separator: ", ")).font(.caption2).foregroundStyle(.secondary) }
                    }
                }
            }
            .navigationTitle("Clips")
            .refreshable { await load() }
            .task { await load() }
        }
    }
    private func label(_ s: String) -> String { ["queued": "Waiting", "scheduled": "Scheduled", "partial": "Uploading", "skipped": "Skipped"][s] ?? s.capitalized }
    private func load() async {
        guard HubLink.isSet else { return }
        do { items = try await HubLink.queue(); error = nil } catch { self.error = error.localizedDescription }
    }
}

// MARK: PC (status + auto / run now, through the hub)

struct PCView: View {
    @State private var online = false
    @State private var up: HubLink.Uploader?
    @State private var accounts: [HubLink.PCAccount] = []
    @State private var error: String?
    @State private var busy = false
    var body: some View {
        NavigationStack {
            List {
                if !HubLink.isSet { Text("Connect your hub in Settings to see your PC.").foregroundStyle(.secondary) }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                if HubLink.isSet {
                    Section {
                        Label(online ? "PC online" : "PC offline", systemImage: online ? "checkmark.circle.fill" : "moon.zzz").foregroundStyle(online ? .green : .secondary)
                        if let up {
                            Toggle("Auto schedule", isOn: Binding(get: { up.auto }, set: { on in act { try await HubLink.ask("auto", arg: ["on": on]) } })).disabled(busy || !online)
                            Button(busy ? "Working..." : "Run now") { act { try await HubLink.ask("runNow") } }.disabled(busy || !online)
                            if let t = up.lastTick { Text("Last run " + Date(timeIntervalSince1970: t / 1000).formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(.secondary) }
                            if let s = up.stopReason { Text("Stopped: " + s).font(.caption).foregroundStyle(.red) } else if let e = up.lastError { Text(e).font(.caption).foregroundStyle(.orange) }
                        }
                    }
                    if !accounts.isEmpty { Section("Posts to") { ForEach(accounts, id: \.id) { a in Text("\(a.label) · \(a.cap)/day\(a.on ? "" : " (off)")") } } }
                    if let up, !up.recent.isEmpty { Section("Recent") { ForEach(up.recent, id: \.self) { Text($0).font(.caption2.monospaced()) } } }
                }
            }
            .navigationTitle("PC")
            .refreshable { await load() }
            .task { await load() }
        }
    }
    private func act(_ f: @escaping () async throws -> Void) {
        busy = true
        Task { defer { busy = false }; do { try await f(); await load() } catch { self.error = error.localizedDescription } }
    }
    private func load() async {
        guard HubLink.isSet else { return }
        do {
            async let o = HubLink.pcOnline(); async let u = HubLink.uploader(); async let a = HubLink.accounts()
            let (on, u2, a2) = try await (o, u, a)
            online = on; up = u2; accounts = a2; error = nil
        } catch { self.error = error.localizedDescription }
    }
}

// MARK: Settings

struct SettingsView: View {
    @State private var apiKey = ""
    @State private var hubKey = ""
    @State private var pass = ""
    @State private var msg: String?
    @State private var working = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField(Keychain.apiKey.isEmpty ? "Paste the API key" : "Saved. Paste a new one to replace it", text: $apiKey)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    Button("Save key") {
                        working = true
                        let old = Keychain.apiKey
                        Keychain.apiKey = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task {
                            defer { working = false }
                            do { let a = try await API.accounts(); msg = "Key works. Linked: " + a.map { $0.displayName ?? $0.handle }.joined(separator: ", "); apiKey = "" }
                            catch { Keychain.apiKey = old; msg = "That key didn't work: " + error.localizedDescription }
                        }
                    }.disabled(apiKey.isEmpty || working)
                } header: { Text("Chaosity Vault iHatePosting account") } footer: { Text("The second iHatePosting account (not your main one). Stored in this iPhone's Keychain.") }
                Section {
                    SecureField(HubLink.isSet ? "Connected. Paste a new key to replace it" : "Device key (hub_...)", text: $hubKey)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    SecureField("Vault passphrase", text: $pass).autocorrectionDisabled().textInputAutocapitalization(.never)
                    Button(working ? "Connecting..." : "Connect") {
                        working = true
                        Task { defer { working = false }; do { msg = try await HubLink.connect(key: hubKey, pass: pass); hubKey = ""; pass = "" } catch { msg = error.localizedDescription } }
                    }.disabled(working)
                    if HubLink.isSet { Button("Disconnect", role: .destructive) { HubLink.deviceKey = ""; HubLink.passphrase = ""; msg = "Disconnected." } }
                } header: { Text("Your hub") } footer: {
                    Text("On api.briangopaul.com/admin.php: Add a device (\"Brian iPhone - Chaosity Vault\"), project chaosityvault, \"Can unlock my saved keys\" ticked. The API key then comes from your vault automatically.")
                }
                if let msg { Section { Text(msg).font(.footnote) } }
            }
            .navigationTitle("Settings")
        }
    }
}

// Chaosity Vault <-> your hub (api.briangopaul.com), project "chaosityvault".
// - The iHatePosting key for this channel's account lives in your vault as "ihateposting_chaosityvault"
//   (locked with your passphrase: PBKDF2-SHA256 210k + AES-256-GCM, same format as Post Library / Comment Helper).
//   Everything else already in the vault is kept as it is.
// - The PC publishes its status and queue, and picks up "auto on/off" and "run now" requests from your other devices.
const crypto = require("crypto");
const BASE = "https://api.briangopaul.com", PROJECT = "chaosityvault", VAULT_NAME = "ihateposting_chaosityvault";

class Hub {
  /** secret: { get(name), set(name, value) } (Windows-encrypted). getKey/setKey: this app's iHatePosting key. */
  constructor({ secret, engine, getKey, setKey, setAuto, log, onChange, stateFile }) {
    Object.assign(this, { secret, engine, getKey, setKey, setAuto, log: log || (() => {}), onChange: onChange || (() => {}), stateFile });
    const fs = require("fs");
    try { this.state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { this.state = {}; }
    this.state = { cursor: 0, published: {}, done: {}, ...this.state };
    this.lastError = null; this.lastSync = null; this.timer = null; this.busy = false;
  }
  get enabled() { return !!this.secret.get("hub-device"); }
  info() { return { connected: this.enabled, vault: !!this.secret.get("hub-vault"), lastSync: this.lastSync, error: this.lastError, project: PROJECT }; }
  save() { const fs = require("fs"); fs.writeFileSync(this.stateFile + ".tmp", JSON.stringify(this.state)); fs.renameSync(this.stateFile + ".tmp", this.stateFile); }

  async call(method, p, body, key) {
    let r;
    try { r = await fetch(BASE + p, { method, headers: { Authorization: "Bearer " + (key || this.secret.get("hub-device")), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(40000) }); }
    catch { throw Object.assign(new Error("Couldn't reach your hub. Check your internet."), { status: 0 }); }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    if (!r.ok) {
      let msg = (j && j.error) || `Hub error ${r.status}.`;
      if (r.status === 401) msg = "The hub didn't accept this device key: " + msg;
      if (r.status === 403) msg = `This device key isn't allowed here. On the hub page, make a key for "${PROJECT}" with "Can unlock my saved keys" ticked.`;
      throw Object.assign(new Error(msg), { status: r.status });
    }
    return j;
  }

  // ---- vault ----
  static lock(secrets, pass) {
    const salt = crypto.randomBytes(16), nonce = crypto.randomBytes(12), key = crypto.pbkdf2Sync(pass, salt, 210000, 32, "sha256");
    const c = crypto.createCipheriv("aes-256-gcm", key, nonce), ct = Buffer.concat([c.update(JSON.stringify(secrets), "utf8"), c.final()]);
    return { v: 1, kdf: "pbkdf2-sha256", iter: 210000, salt: salt.toString("base64"), nonce: nonce.toString("base64"), ct: ct.toString("base64"), tag: c.getAuthTag().toString("base64") };
  }
  static unlock(box, pass) {
    const key = crypto.pbkdf2Sync(pass, Buffer.from(box.salt, "base64"), box.iter || 210000, 32, "sha256");
    try { const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.nonce, "base64")); d.setAuthTag(Buffer.from(box.tag, "base64")); return JSON.parse(Buffer.concat([d.update(Buffer.from(box.ct, "base64")), d.final()]).toString("utf8")); }
    catch { throw new Error("Wrong vault passphrase."); }
  }
  async readVault(pass) {
    try { const r = await this.call("GET", "/v1/vault/docs/secrets/main"); return r && r.data ? Hub.unlock(r.data, pass) : null; }
    catch (e) { if (e.status === 404) return null; throw e; }
  }
  /** Two-way: a key on this PC goes into the vault; a PC without a key takes it from the vault. */
  async syncKey() {
    const pass = this.secret.get("hub-vault"); if (!pass || !this.enabled) return null;
    const all = (await this.readVault(pass)) || {}, local = this.getKey();
    if (local && all[VAULT_NAME] !== local) { all[VAULT_NAME] = local; await this.call("PUT", "/v1/vault/docs/secrets/main", { data: Hub.lock(all, pass) }); this.log("Saved this channel's iHatePosting key to your hub vault."); return "saved"; }
    if (!local && all[VAULT_NAME]) { this.setKey(all[VAULT_NAME]); this.log("Loaded this channel's iHatePosting key from your hub vault."); return "loaded"; }
    return "same";
  }

  async connect(key, pass) {
    key = String(key || "").trim(); pass = String(pass || "");
    if (!key && !this.enabled) throw new Error("Paste the device key from your hub page first.");
    let name = null;
    if (key) { name = (await this.call("GET", "/v1/ping", undefined, key)).device; this.secret.set("hub-device", key); this.state = { cursor: 0, published: {}, done: {} }; this.save(); }
    if (pass) { await this.readVault(pass); this.secret.set("hub-vault", pass); } // throws on a wrong passphrase
    const keyResult = await this.syncKey();
    this.start(); await this.tick();
    return { name, keyResult, ...this.info() };
  }
  disconnect() { this.stop(); this.secret.set("hub-device", ""); this.secret.set("hub-vault", ""); this.state = { cursor: 0, published: {}, done: {} }; this.save(); this.onChange(); }
  start() { if (this.timer || !this.enabled) return; this.timer = setInterval(() => this.tick(), 10000); }
  stop() { clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.busy || !this.enabled) return;
    this.busy = true;
    try { await this.takeRequests(); await this.publish(); this.lastSync = Date.now(); this.lastError = null; }
    catch (e) { this.lastError = e.message; }
    finally { this.busy = false; this.onChange(); }
  }

  /** Only these are allowed from another device: auto on/off and run now. */
  async takeRequests() {
    for (;;) {
      const r = await this.call("GET", `/v1/${PROJECT}/changes?since=${this.state.cursor}&limit=500`);
      for (const c of r.changes) {
        if (c.coll !== "requests" || c.deleted || !c.data || c.data.state !== "new" || this.state.done[c.id]) continue;
        this.state.done[c.id] = Date.now();
        const q = c.data, reply = { ...q, state: "done", doneAt: Date.now() };
        if (q.method === "auto") { this.setAuto(!!(q.arg && q.arg.on)); reply.result = { auto: !!(q.arg && q.arg.on) }; this.log(`From another device: auto ${q.arg && q.arg.on ? "on" : "off"}`); }
        else if (q.method === "runNow") { this.engine.tick(); reply.result = { ok: true }; }
        // Nov 13 2026: "Run collabs now" from the phone (collab.js check, forced; runs Claude in the background on the PC).
        else if (q.method === "collabRun" && this.collab) { const r = await this.collab.check({ force: true }); reply.result = { result: r, collab: this.collab.status() }; this.log("From your phone: run collabs (" + r + ")"); }
        else { reply.state = "failed"; reply.error = "That request isn't allowed."; }
        await this.call("PUT", `/v1/${PROJECT}/docs/requests/${encodeURIComponent(c.id)}`, { data: reply });
      }
      this.state.cursor = r.cursor;
      if (!r.more) break;
    }
    const old = Object.entries(this.state.done).filter(([, at]) => Date.now() - at > 864e5).map(([id]) => id);
    if (old.length) { await this.call("POST", `/v1/${PROJECT}/batch`, { ops: old.map(id => ({ op: "delete", coll: "requests", id })) }); for (const id of old) delete this.state.done[id]; }
    this.save();
  }

  /** Sends what changed: uploader status, linked accounts, the clip queue, and a once-a-minute heartbeat. No keys, ever. */
  async publish() {
    const ops = [], fp = v => crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);
    const put = (coll, id, data) => { const k = coll + "/" + id, f = fp(data); if (this.state.published[k] === f) return; ops.push({ op: "put", coll, id, data }); this.state.published[k] = f; };
    const st = this.engine.state, s = st.settings || {};
    if (this.collab) { const cs = this.collab.status(); put("pc", "collab", { ...cs, pendingTitles: (cs.pendingTitles || []).slice(0, 30) }); }
    put("pc", "uploader", { auto: !!s.auto, status: this.engine.status || "Idle", lastTick: st.lastTick || null, lastError: st.lastError || null, stopReason: st.stopReason || null, signIn: !!st.signIn, hasKey: !!this.getKey(), recent: this.engine.logs(15) });
    put("pc", "accounts", { accounts: (st.accounts || []).map(a => ({ id: a.id, platform: a.platform, label: a.label, cap: a.cap, on: s.accounts?.[a.id] !== false })) });
    put("queue", "_list", { items: (this.engine.queue.items || []).map(i => ({ file: i.file, title: i.title, game: i.game, dur: i.dur, status: i.status, sched: i.sched || {}, postedAt: i.postedAt || null })) });
    if (!this.state.beat || Date.now() - this.state.beat > 60000) { this.state.beat = Date.now(); ops.push({ op: "put", coll: "pc", id: "status", data: { at: Date.now() } }); }
    for (let i = 0; i < ops.length; i += 200) await this.call("POST", `/v1/${PROJECT}/batch`, { ops: ops.slice(i, i + 200) });
    this.save();
  }
}
module.exports = { Hub, PROJECT };

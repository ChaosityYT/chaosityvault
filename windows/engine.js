// Background worker for the second channel. When the app opens, when the PC wakes, and every few minutes:
//   1. Reads which accounts the linked iHatePosting account has (YouTube / TikTok, active only).
//   2. Reads the clip folder and its titles file.
//   3. A clip whose posts have all published moves to <folder>\Posted.
//   4. A library file whose posts have ALL published is deleted (needs the website sign-in; anything scheduled or failed is kept).
//   5. Freed space is refilled: the next clip is compressed, uploaded and scheduled into the next open slot.
// Caps follow Brian's rules: 9/day per YouTube channel (rolling 24 h), 12/day per TikTok, posts 6 s apart,
// and it STOPS and notifies on any limit or account message instead of working around it.
const fs = require("fs"), path = require("path"), { spawn } = require("child_process");
const { api, sleep } = require("./api");
const { rescan, captions, writePlan, parseWhen, movePosted, hasTikTokVersion, srcPath } = require("./importer");
const { NAME, DATA, KIT, TZ } = require("./config");

const QUEUE_F = path.join(DATA, "queue.json"), STATE_F = path.join(DATA, "state.json"), LOG_F = path.join(DATA, "log.txt");
const FF = KIT + "/tools/ffmpeg/bin/ffmpeg.exe", UP = path.join(DATA, "upload");
const hm = s => { const [h, m] = s.split(":"); return +h * 60 + +m; };
const PLATFORM = {
  youtube: { cap: 9, rolling: true, slots: ["9:00", "10:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"] },
  tiktok: { cap: 12, rolling: false, slots: ["10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00"] },
};
const STOP_WORDS = /limit|room again|too many|quota|suspend|disabled|banned|terminated|reconnect|expired|unauthori|revoked|spam/i;
const DEFAULTS = { auto: true, autoDelete: true, tickMin: 5, budgetMB: 500, maxDur: 32, horizonDays: 3, accounts: {} };

const localParts = ts => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ts).map(x => [x.type, x.value])); return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute }; };
function toTs(date, min) { const want = Date.parse(`${date}T00:00:00Z`) + min * 60000; let t = want; for (let i = 0; i < 2; i++) { const l = localParts(t); t += want - (Date.parse(`${l.date}T00:00:00Z`) + l.min * 60000); } return t; }
const addDays = (d, n) => new Date(Date.parse(d + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const clock = m => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const fmtDay = w => `${w.date} ${clock(w.min)}`;
const PLAN_DAYS = 120;

class Engine {
  constructor({ deleteMedia, notify, onChange, dry } = {}) {
    this.deleteMediaFn = deleteMedia; this.notify = notify || (() => {}); this.onChange = onChange || (() => {}); this.dry = !!dry;
    fs.mkdirSync(DATA, { recursive: true });
    this.state = { postInfo: {}, lastTick: null, lastError: null, stopReason: null, seenFailed: [], accounts: [], ...this.read(STATE_F, {}) };
    this.state.settings = { ...DEFAULTS, ...(this.state.settings || {}) };
    this.queue = this.read(QUEUE_F, { items: [] });
    this.running = false; this.timer = null; this.status = "Idle"; this.lastOk = false; this.planError = null; this.lastLine = null;
  }
  read(f, d) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } }
  save() { if (this.dry) return; for (const [f, v] of [[STATE_F, this.state], [QUEUE_F, this.queue]]) { fs.writeFileSync(f + ".tmp", JSON.stringify(v)); fs.renameSync(f + ".tmp", f); } this.onChange(); }
  log(s) { const l = `${new Date().toLocaleString("en-US", { timeZone: TZ })}  ${s}`; console.log(l); if (!this.dry) fs.appendFileSync(LOG_F, l + "\n"); }
  logs(n = 200) { try { return fs.readFileSync(LOG_F, "utf8").trim().split("\n").slice(-n).reverse(); } catch { return []; } }
  stop(reason) { this.state.stopReason = reason; this.state.settings.auto = false; this.log("STOPPED: " + reason); this.notify(`${NAME} stopped scheduling`, reason); this.save(); }
  logOnce(s) { if (this.lastLine === s) return false; this.lastLine = s; this.log(s); return true; }

  /** Accounts the posts go to: every ACTIVE YouTube/TikTok account on the linked iHatePosting account (switchable in the app). */
  get accounts() {
    const on = this.state.settings.accounts;
    return this.state.accounts.filter(a => on[a.id] !== false);
  }
  async loadAccounts() {
    const r = await api.accounts();
    const list = (r.accounts || []).filter(a => a.status === "active" && PLATFORM[a.platform]);
    const count = {};
    this.state.accounts = list.map(a => {
      const n = count[a.platform] = (count[a.platform] || 0) + 1;
      const p = PLATFORM[a.platform], offset = (n - 1) * 30; // a second account on the same platform posts half an hour later
      return { id: a.id, platform: a.platform, label: `${a.platform === "youtube" ? "YouTube" : "TikTok"} ${a.displayName || a.handle}`, cap: p.cap, rolling: p.rolling, slots: p.slots.map(s => hm(s) + offset) };
    });
    const skipped = (r.accounts || []).filter(a => !(a.status === "active" && PLATFORM[a.platform]));
    for (const a of skipped) this.logOnce(`Not posting to ${a.platform} ${a.displayName || a.handle} (${a.status !== "active" ? "status: " + a.status : "this app posts to YouTube and TikTok only"}).`);
    if (!this.state.accounts.length) throw new Error("The linked iHatePosting account has no active YouTube or TikTok account yet. Connect the channel on ihateposting.com first.");
  }

  rescan() {
    const r = rescan(this.queue, this.accounts, { write: !this.dry, maxDur: this.state.settings.maxDur });
    this.planError = r.error; if (r.error) this.logOnce(r.error);
    if (r.added) this.log(`Found ${r.added} new clip${r.added === 1 ? "" : "s"} in the clip folder.`);
    this.save(); return r.added;
  }
  setItem(file, patch) {
    const i = this.queue.items.find(x => x.file === file); if (!i) return;
    Object.assign(i, patch); this.save();
    if (!writePlan(this.queue, this.accounts, this.state.settings.maxDur)) throw new Error("Close the titles file in Excel first, then make this change again.");
  }

  async runOnOpen() { for (let n = 0; n < 6; n++) { await this.tick(); if (this.lastOk || this.noKey) return; await sleep(60000); } }
  start() { this.schedule(); }
  schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => { this.schedule(); this.tick().catch(e => this.log("Error: " + e.message)); }, this.state.settings.tickMin * 60000); }

  async snapshot() {
    const media = await api.media();
    const oldest = media.assets.reduce((a, x) => (x.createdAt < a ? x.createdAt : a), new Date().toISOString());
    const from = localParts(Math.min(Date.parse(oldest), Date.now() - 2 * 864e5)).date;
    const posts = [];
    for (const s of ["scheduled", "publishing", "failed", "partial"]) posts.push(...await api.posts(s));
    posts.push(...await api.posts("published", from));
    for (const p of posts) {
      if (this.state.postInfo[p.id]) continue;
      const d = await api.post(p.id);
      this.state.postInfo[p.id] = { acc: (d.targets[0] || {}).socialAccountId, media: (d.media || []).map(m => m.media ? m.media.id : m.id) };
    }
    return { media, posts };
  }

  markPosted(snap) {
    if (!this.state.settings.auto || this.dry) return;
    const refs = {}; for (const p of snap.posts) for (const m of (this.state.postInfo[p.id] || {}).media || []) (refs[m] = refs[m] || []).push(p);
    for (const i of this.queue.items.filter(x => x.status === "scheduled")) {
      const rs = [...new Set(Object.values(i.media || {}))].flatMap(m => refs[m] || []);
      if (!rs.length || rs.length < Object.keys(i.posts).length) continue;
      if (!rs.every(p => p.status === "published" && p.targets.every(t => t.status === "published"))) continue;
      i.status = "posted"; i.postedAt = Date.now();
      try { movePosted(i.file); } catch (e) { this.log(`Couldn't move ${i.file} to Posted: ${e.message}`); }
      this.log(`Posted everywhere: ${i.title}`);
    }
  }

  async cleanup(snap) {
    if (!this.state.settings.autoDelete || (!this.state.settings.auto && !this.dry)) return [];
    const refs = {}; for (const p of snap.posts) for (const m of (this.state.postInfo[p.id] || {}).media || []) (refs[m] = refs[m] || []).push(p);
    const gone = [];
    for (const a of snap.media.assets) {
      const r = refs[a.id]; if (!r || !r.length) continue; // never used by a post: not touched
      const allDone = r.every(p => p.status === "published" && p.targets.every(t => t.status === "published"));
      const newest = Math.max(...r.map(p => Date.parse(p.publishedAt || p.scheduledAt)));
      if (!allDone || Date.now() - newest < 10 * 60000) continue;
      if (this.queue.items.some(i => i.status === "partial" && Object.values(i.media || {}).includes(a.id))) continue;
      if (this.dry) { this.log(`[dry] would delete from library: ${decodeURIComponent(a.url.split("/").pop())}`); gone.push(a.id); continue; }
      if (!this.deleteMediaFn) continue;
      const res = await this.deleteMediaFn(a.id);
      if (res.ok) { this.log(`Deleted from library (published): ${decodeURIComponent(a.url.split("/").pop())}`); gone.push(a.id); this.state.signIn = false; this.state.signInOk = true; }
      else {
        this.state.signIn = !!res.signedOut; if (res.signedOut) this.state.signInOk = false;
        this.state.lastError = res.signedOut ? "Sign in to iHatePosting (this channel's account) so the app can delete published files." : `Library delete failed (HTTP ${res.status})`;
        if (this.logOnce(this.state.lastError)) this.notify(NAME, this.state.lastError);
        break;
      }
      await sleep(1500);
    }
    return gone;
  }

  slotOk(a, ts, date, mine) {
    if (ts < Date.now() + 15 * 60000) return false;
    if (mine.filter(o => o.date === date).length >= a.cap) return false;
    if (mine.some(o => Math.abs(o.ts - ts) < 25 * 60000)) return false;
    if (a.rolling) {
      if (mine.filter(o => o.ts > ts - 864e5 && o.ts <= ts).length >= a.cap) return false;
      if (mine.filter(o => o.ts >= ts && o.ts < ts + 864e5).length >= a.cap) return false;
    }
    return true;
  }
  findSlot(a, occupied, fromDay = 0) {
    const today = localParts(Date.now()).date, mine = occupied.filter(o => o.acc === a.id);
    for (let d = fromDay; d <= PLAN_DAYS; d++) {
      const date = addDays(today, d);
      for (const min of a.slots) { const ts = toTs(date, min); if (this.slotOk(a, ts, date, mine)) return { date, min, ts, day: d }; }
    }
    return null;
  }

  wantedAccounts(i) { return this.accounts.filter(a => (a.platform === "youtube" ? i.hasYT : i.hasTT) && !i.posts[a.id]); }
  ready(i) { const s = this.state.settings; return i.status === "queued" && (i.allowLong || i.dur <= s.maxDur) && this.wantedAccounts(i).length > 0; }

  planTimes(occupied) {
    const q = this.queue, tmp = occupied.slice();
    const active = q.items.filter(i => i.status === "partial" || this.ready(i)).sort((a, b) => (b.status === "partial") - (a.status === "partial"));
    const on = new Set(active);
    for (const i of q.items) if (!on.has(i) && i.status !== "scheduled" && i.status !== "posted") i.sched = { ...(i.fixed || {}) };
    for (const i of active) {
      i.sched = {};
      for (const a of this.wantedAccounts(i)) {
        const f = i.fixed?.[a.id]; if (!f) continue;
        const ts = toTs(f.date, f.min);
        if (this.slotOk(a, ts, f.date, tmp.filter(o => o.acc === a.id))) { i.sched[a.id] = f; tmp.push({ acc: a.id, ts, date: f.date }); }
        else { this.log(`${fmtDay(f)} doesn't work for ${a.label} (already past, over the daily limit, or under 25 minutes from another post). Moved "${i.title}" to the next open slot.`); delete i.fixed[a.id]; }
      }
    }
    const from = {};
    for (const i of active) for (const a of this.wantedAccounts(i)) {
      if (i.sched[a.id]) continue;
      const slot = this.findSlot(a, tmp, from[a.id] || 0); if (!slot) continue;
      from[a.id] = Math.max(0, slot.day - 1);
      i.sched[a.id] = { date: slot.date, min: slot.min }; tmp.push({ acc: a.id, ts: slot.ts, date: slot.date });
    }
  }

  syncScheduled(snap) {
    const byId = new Map(snap.posts.map(p => [p.id, p]));
    for (const i of this.queue.items) for (const [a, id] of Object.entries(i.posts || {})) {
      const l = byId.get(id)?.scheduledLocal; if (!l) continue;
      const w = parseWhen(`${l.date} ${l.time}`); if (w) (i.sched = i.sched || {})[a] = w;
    }
  }
  occupiedFrom(snap) {
    const ids = new Set(this.state.accounts.map(a => a.id)), occupied = [];
    for (const p of snap.posts) { const acc = (this.state.postInfo[p.id] || {}).acc; if (ids.has(acc) && p.scheduledLocal) occupied.push({ acc, ts: Date.parse(p.scheduledAt), date: p.scheduledLocal.date }); }
    return occupied;
  }
  nextItem() {
    const resume = this.queue.items.find(i => i.status === "partial"); if (resume) return resume;
    const first = i => Math.min(...this.wantedAccounts(i).map(a => (i.sched?.[a.id] ? toTs(i.sched[a.id].date, i.sched[a.id].min) : Infinity)));
    let best = null, at = Infinity;
    for (const i of this.queue.items) { if (!this.ready(i)) continue; const t = first(i); if (t < at) { at = t; best = i; } }
    return best;
  }
  mediaKey(a, file) { return a.platform === "youtube" || !hasTikTokVersion(file) ? "Shorts" : "TikTok"; }

  async compress(version, file) {
    fs.mkdirSync(UP, { recursive: true });
    const key = `${version} ${file.replace(/\.\w+$/, "")}.mp4`, up = `${UP}/${key}`, part = `${UP}/part ${key}`;
    if (!(fs.existsSync(up) && fs.statSync(up).size)) {
      await new Promise(done => {
        const p = spawn(FF, ["-v", "error", "-y", "-i", srcPath(version, file), "-c:v", "h264_nvenc", "-preset", "p6", "-rc", "vbr", "-b:v", "5500k", "-maxrate", "8000k", "-bufsize", "11000k", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", part], { stdio: "ignore", windowsHide: true });
        const kill = setTimeout(() => { try { p.kill(); } catch {} }, 10 * 60000);
        p.on("close", code => { clearTimeout(kill); if (code === 0 && fs.existsSync(part)) fs.renameSync(part, up); else fs.rmSync(part, { force: true }); done(); });
        p.on("error", done);
      });
    }
    if (!fs.existsSync(up) || !fs.statSync(up).size) throw new Error("Could not compress " + file);
    return { up, key, size: fs.statSync(up).size };
  }

  async refill(snap, freed, occupied) {
    const s = this.state.settings;
    if (!s.auto && !this.dry) return;
    let used = snap.media.usage.usedBytes - snap.media.assets.filter(a => freed.includes(a.id)).reduce((t, a) => t + a.sizeBytes, 0);
    for (let n = 0; n < 8; n++) {
      this.planTimes(occupied);
      const item = this.nextItem();
      if (!item) { if (this.logOnce("No clips left to post in the clip folder.")) this.notify(`${NAME} is out of clips`, "Add more to the clip folder."); break; }
      const c = captions(item), wanted = this.wantedAccounts(item);
      const plan = {}, lastDay = addDays(localParts(Date.now()).date, s.horizonDays); let full = null;
      for (const a of wanted) { const w = item.sched?.[a.id]; if (!w || w.date > lastDay) { full = a; break; } plan[a.id] = { date: w.date, min: w.min, ts: toTs(w.date, w.min) }; }
      if (full) { this.logOnce(`Next post for ${full.label} is more than ${s.horizonDays} days out; waiting.`); break; }

      const versions = [...new Set(wanted.map(a => this.mediaKey(a, item.file)))];
      const files = {}; let size = 0;
      if (this.dry) for (const v of versions) { const f = fs.statSync(srcPath(v, item.file)).size; files[v] = f; size += Math.min(f, item.dur * 750000); }
      else for (const v of versions) { if (item.media?.[v]) continue; files[v] = await this.compress(v, item.file); size += files[v].size; }
      if (used + size > s.budgetMB * 1e6) { this.logOnce(`Library full (${s.budgetMB} MB budget); waiting for posts to publish.`); break; }

      if (this.dry) { for (const a of wanted) { this.log(`[dry] ${a.label.padEnd(26)} ${plan[a.id].date} ${clock(plan[a.id].min)}  ${item.title}`); occupied.push({ acc: a.id, ts: plan[a.id].ts, date: plan[a.id].date }); } used += size; item.status = "dry"; continue; }

      item.media = item.media || {};
      for (const v of versions) if (!item.media[v]) { const asset = await api.upload(files[v].up, files[v].key); item.media[v] = asset.id; used += files[v].size; fs.rmSync(files[v].up, { force: true }); }
      item.status = "partial"; this.save();
      for (const a of wanted) {
        const yt = a.platform === "youtube";
        const r = await api.create({
          text: yt ? c.ytText : c.ttText, platforms: [a.id], action: "schedule",
          scheduledDate: plan[a.id].date, scheduledTime: clock(plan[a.id].min), mediaIds: [item.media[this.mediaKey(a, item.file)]],
          options: yt ? { youtube: { ytTitle: c.ytTitle, ytMadeForKids: "no", ytPrivacy: "public", ytCategory: "entertainment", ytTags: item.ytTags } }
            : { tiktok: { tiktokPrivacy: "public", tiktokAllowComment: true, tiktokAllowDuet: true, tiktokAllowStitch: true } },
        });
        item.posts[a.id] = (r.post && r.post.id) || true; occupied.push({ acc: a.id, ts: plan[a.id].ts, date: plan[a.id].date });
        this.log(`Scheduled ${a.label} ${plan[a.id].date} ${clock(plan[a.id].min)}: ${item.title}`);
        this.save();
      }
      item.status = "scheduled"; item.scheduledAt = Date.now(); this.save();
    }
  }

  checkFailures(snap) {
    const ids = new Set(this.state.accounts.map(a => a.id));
    for (const p of snap.posts.filter(p => p.status === "failed" || p.status === "partial")) {
      if (this.state.seenFailed.includes(p.id)) continue;
      this.state.seenFailed.push(p.id);
      if (!ids.has((this.state.postInfo[p.id] || {}).acc)) continue;
      const err = (p.targets.find(t => t.error) || {}).error || "no reason given";
      this.log(`Post failed: ${p.baseContent.slice(0, 60)} - ${err}`);
      this.notify("A post failed", `${p.baseContent.slice(0, 60)}: ${err}`);
      if (STOP_WORDS.test(err) && this.state.settings.auto) this.stop(`A post was refused: ${err}`);
    }
  }

  async tick() {
    if (this.running) { if (Date.now() - (this.runStarted || 0) < 45 * 60000) return; this.log("The previous run was stuck for 45+ minutes; starting a fresh one."); }
    this.running = true; this.runStarted = Date.now(); this.status = "Working"; this.lastOk = false; this.noKey = false; this.onChange();
    try {
      let accErr = null;
      try { await this.loadAccounts(); } catch (e) { accErr = e; }
      this.rescan(); // the clip list shows even before the key is added
      if (accErr) throw accErr;
      const snap = await this.snapshot();
      this.checkFailures(snap);
      this.markPosted(snap);
      const freed = await this.cleanup(snap);
      const occupied = this.occupiedFrom(snap);
      await this.refill(snap, freed, occupied);
      this.syncScheduled(snap);
      this.planTimes(occupied);
      if (!this.state.signIn) this.state.lastError = this.planError || null;
      this.state.lastTick = Date.now(); this.lastOk = true;
      if (!this.dry && !this.planError) writePlan(this.queue, this.accounts, this.state.settings.maxDur);
      const live = new Set(snap.posts.map(p => p.id)); for (const k of Object.keys(this.state.postInfo)) if (!live.has(k)) delete this.state.postInfo[k];
    } catch (e) {
      this.noKey = !!e.noKey;
      this.state.lastError = e.message; this.logOnce("Error: " + e.message);
      if (STOP_WORDS.test(e.message) && e.status !== 429 && !e.noKey) this.stop(e.message);
    }
    this.running = false; this.status = "Idle"; this.save();
  }
}
module.exports = { Engine };

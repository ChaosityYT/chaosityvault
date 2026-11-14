// Collab (Nov 13 2026, Brian's request, shorts only): after a short goes live on this app's YouTube channel
// (Post Library -> Chaosity Clips, Chaosity Vault app -> Chaosity Vault), the main Chaosity channel should be added
// as a collaborator and the invite accepted as the main channel.
// Google blocks sign-in inside the app's own browser, so the app doesn't do the clicking itself. Instead, when new
// shorts are waiting, it shows a notification; one click from Brian opens Claude Code with Claude in Chrome, which does
// the collabs in his real, already signed-in Chrome and writes back which videos are done (collab-done.txt).
// Nothing here hides automation from Google, copies cookies, or acts without Brian's click.
// The same file is used by both apps (copy it across when it changes).
const path = require("path"), fs = require("fs"), os = require("os");

const MAIN = { handle: "@ChaosityYouTube", id: "UCopSfrN6QxKMQEquo6YzizA" };
const LOCK = path.join(os.tmpdir(), "chaosity-collab-claude.lock"); // one Claude collab window at a time across both apps

class Collab {
  /** opts: { app, log(text), onChange(), notify(title, body, onClick), findClaude() -> exe path, owner: { handle, name }, videos: async () => [{ videoId, title }] } */
  constructor(opts) {
    Object.assign(this, opts);
    this.dir = this.app.getPath("userData");
    this.file = path.join(this.dir, "collab.json");
    this.doneFile = path.join(this.dir, "collab-done.txt");
    this.taskFile = path.join(this.dir, "collab-task.md");
    try { this.state = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { this.state = {}; }
    this.state.done = this.state.done || {};      // videoId -> { title, at }
    this.state.posts = this.state.posts || {};    // iHatePosting post id -> { videoId, liveAt } | { old: true }
    this.state.enabled = this.state.enabled !== false;
    this.state.related = this.state.related || {}; // main-channel short id -> long video id it links to (Related video)
    this.pending = [];
    this.relPending = [];
    this.layoutPending = false;
  }
  /** Newest long video, when this app also sets Related video on main-channel shorts (Post Library only). */
  latest() { const L = this.related && this.related.latest(); return L && /^[\w-]{11}$/.test(L.videoId) ? L : null; }
  save() { try { fs.writeFileSync(this.file, JSON.stringify(this.state, null, 1)); } catch {} }
  note(s) { this.state.last = `${new Date().toLocaleString()}: ${s}`; this.save(); this.log("Collab: " + s); this.onChange && this.onChange(); }

  status() {
    const L = this.latest();
    return { enabled: this.state.enabled, done: Object.keys(this.state.done).length, pending: this.pending.length + this.relPending.length + (this.layoutPending ? 1 : 0),
      pendingTitles: this.pending.map(v => v.title).concat(this.relPending.map(v => "link: " + v.title), this.layoutPending ? ["channel trailer + featured video"] : []), running: this.claudeRunning(), last: this.state.last || "",
      related: this.related ? { latest: L ? L.title : null, done: Object.keys(this.state.related).length, pending: this.relPending.length } : null };
  }
  setEnabled(on) { this.state.enabled = !!on; this.save(); this.onChange && this.onChange(); }

  /** Videos Claude reported as done (one id per line, written by the Claude session). */
  readDone() {
    let lines = [];
    try { lines = fs.readFileSync(this.doneFile, "utf8").split(/\r?\n/); } catch { return; }
    let n = 0, r = 0;
    for (const l of lines) {
      const lay = /^layout\s+([\w-]{11})/.exec(l.trim());
      if (lay) { if (this.state.layout !== lay[1]) { this.state.layout = lay[1]; this.layoutPending = false; this.note("channel trailer + featured video now show your latest video"); } continue; }
      const rel = /^([\w-]{11})\s+related\s+([\w-]{11})/.exec(l.trim());
      if (rel) { if (this.state.related[rel[1]] !== rel[2]) { this.state.related[rel[1]] = rel[2]; r++; } continue; }
      const m = /^([\w-]{11})\b/.exec(l.trim()); if (!m || this.state.done[m[1]]) continue;
      const v = this.pending.find(x => x.videoId === m[1]);
      this.state.done[m[1]] = { title: v ? v.title : "", at: Date.now() }; n++;
    }
    if (n) { this.pending = this.pending.filter(v => !this.state.done[v.videoId]); this.note(`${n} short${n === 1 ? "" : "s"} now have your main channel as a collaborator`); }
    if (r) { this.relPending = this.relPending.filter(v => this.state.related[v.videoId] !== v.target); this.note(`${r} main-channel short${r === 1 ? "" : "s"} now link to your latest video`); }
  }
  claudeRunning() { try { return Date.now() - fs.statSync(LOCK).mtimeMs < 40 * 60000; } catch { return false; } }

  /** Checks for live shorts without the collab yet; when there are some, shows one notification (at most every 3 h). */
  async check({ fromLaunch, force } = {}) {
    if (!this.state.enabled) return "off";
    this.readDone();
    const list = (await this.videos()).filter(v => v && /^[\w-]{11}$/.test(v.videoId) && !this.state.done[v.videoId]);
    this.pending = list;
    // Main-channel shorts from the last 7 days whose Related video isn't the newest long video yet
    // (when a new long video comes out, they all get re-pointed to it).
    const L = this.latest();
    this.relPending = L ? (await this.related.videos()).filter(v => v && /^[\w-]{11}$/.test(v.videoId) && v.videoId !== L.videoId && this.state.related[v.videoId] !== L.videoId).map(v => ({ ...v, target: L.videoId })) : [];
    // Channel trailer + featured video (Customization -> Layout) follow the newest long video too.
    this.layoutPending = !!(L && this.state.layout !== L.videoId);
    this.onChange && this.onChange();
    if (!list.length && !this.relPending.length && !this.layoutPending) return "nothing waiting";
    if (this.claudeRunning()) return "already running";
    // Brian, Nov 13 2026: run by itself at startup and every hour when there's work (no click). The app skips this while OBS is open.
    if (!fromLaunch && !force && Date.now() - (this.state.autoAt || 0) < 55 * 60000) return "waiting for the next hourly run";
    this.state.autoAt = Date.now(); this.save();
    return (await this.start({ auto: true })) ? "started" : (this.state.last || "couldn't start");
  }

  /** Is Chrome running? Claude in Chrome needs it open (that's where Brian's sign-in is). */
  chromeOpen() {
    return new Promise(res => require("child_process").execFile("tasklist", ["/FI", "IMAGENAME eq chrome.exe", "/NH"], { windowsHide: true, timeout: 10000 }, (e, out) => res(!e && /chrome\.exe/i.test(out || ""))));
  }

  /**
   * Runs Claude Code (Claude in Chrome) on the task.
   * auto: in the background (no window, tools pre-allowed, output to collab-run.log), started by the hourly check.
   * otherwise: a visible console (the "Do collabs now" button) so Brian can watch it.
   */
  async start({ auto } = {}) {
    if (!this.pending.length && !this.relPending.length && !this.layoutPending) { this.note("nothing waiting"); return false; }
    if (this.claudeRunning()) { this.note("Claude is already working on it"); return false; }
    const exe = this.findClaude && this.findClaude();
    if (!exe) { this.note("Claude Code wasn't found on this PC"); return false; }
    const { spawn } = require("child_process");
    if (!(await this.chromeOpen())) {
      // Chrome closed: open it minimized so Claude in Chrome can connect, then give it a moment.
      spawn("cmd.exe", ["/c", "start", "/min", '""', "chrome"], { detached: true, stdio: "ignore", windowsVerbatimArguments: true, windowsHide: true }).unref();
      await new Promise(r => setTimeout(r, 20000));
    }
    fs.writeFileSync(this.taskFile, this.task());
    fs.writeFileSync(LOCK, String(Date.now()));
    const prompt = `Do the YouTube channel tasks listed in ${this.taskFile} (Brian set this up to run from the ${this.app.getName()} app). Follow that file exactly.`;
    const total = this.pending.length + this.relPending.length + (this.layoutPending ? 1 : 0);
    const finish = () => { this.readDone(); try { fs.unlinkSync(LOCK); } catch {} this.onChange && this.onChange(); };
    if (auto) {
      const logFile = path.join(this.dir, "collab-run.log");
      const out = fs.openSync(logFile, "a");
      fs.writeSync(out, `\n===== ${new Date().toLocaleString()} (${total} job${total === 1 ? "" : "s"}) =====\n`);
      const child = spawn(exe, ["-p", prompt, "--chrome", "--allowedTools", "mcp__claude-in-chrome__*,Read,Write,Edit,Bash(echo:*)"],
        { cwd: this.dir, stdio: ["ignore", out, out], windowsHide: true });
      const killer = setTimeout(() => { try { child.kill(); } catch {} }, 40 * 60000); // never let a run hang for hours
      child.on("exit", code => { clearTimeout(killer); try { fs.closeSync(out); } catch {} finish(); if (code) this.note(`Claude run ended with code ${code} (see collab-run.log)`); });
      child.on("error", e => { clearTimeout(killer); finish(); this.note("Claude couldn't start: " + e.message); });
      this.note(`Claude is doing ${total} job${total === 1 ? "" : "s"} in Chrome (in the background)`);
    } else {
      // A visible console window so Brian can watch it and answer any permission question.
      spawn("cmd.exe", ["/c", "start", `"Claude collabs - ${this.owner.name}"`, "/D", `"${this.dir}"`, `"${exe}"`, "--chrome", `"${prompt.replace(/"/g, "'")}"`],
        { detached: true, stdio: "ignore", windowsVerbatimArguments: true, windowsHide: false }).unref();
      this.note(`opened Claude for ${total} job${total === 1 ? "" : "s"}`);
      const t = setInterval(() => { this.readDone(); if ((!this.pending.length && !this.relPending.length && !this.layoutPending) || !this.claudeRunning()) { clearInterval(t); finish(); } }, 30000);
    }
    return true;
  }

  task() {
    const rows = this.pending.map(v => `- ${v.videoId}  ${v.title}`).join("\n") || "(none this time: skip Part A)";
    const L = this.latest(), relRows = this.relPending.map(v => `- ${v.videoId}  ${v.title}`).join("\n");
    const relSection = !(relRows && L) ? "" : `
## Part B: Related video link on main-channel shorts
These shorts are on the main channel **Chaosity (${MAIN.handle})**. Set each one's **Related video** to Brian's newest long video:
**${L.title}** (video id ${L.videoId}, https://youtu.be/${L.videoId}).

${relRows}

Steps (switch account to Chaosity, ${MAIN.handle}, first):
1. Open https://studio.youtube.com/video/<id>/edit -> click **Related video** -> in "Choose specific video" search the first few
   words of the title above, pick the video with id ${L.videoId} -> click **Save** ("Changes saved"). Change nothing else.
2. After each one is saved (or already links to it), append this line to ${this.doneFile}:
   <short id> related ${L.videoId}
`;
    const laySection = !(this.layoutPending && L) ? "" : `
## Part C: Channel homepage layout (main channel)
Brian's newest long video is **${L.title}** (id ${L.videoId}). As Chaosity (${MAIN.handle}), open YouTube Studio ->
**Customization** -> **Layout** and set BOTH of these to that video (use each one's options/edit button -> Replace/Change video,
search the first few words of the title, pick id ${L.videoId}):
- **Channel trailer for people who haven't subscribed**
- **Featured video for returning subscribers**
Then click **Publish** (top right). Change no other section. When both show the new video, append this line to ${this.doneFile}:
   layout ${L.videoId}
`;
    return `# YouTube collabs for ${this.owner.name} (started by Brian from the ${this.app.getName()} app)

Brian asked for this: add his main channel **Chaosity (${MAIN.handle})** as a collaborator on each short below,
which are on his channel **${this.owner.name} (${this.owner.handle})**, then accept each invite as the main channel.
Use Claude in Chrome in Brian's own Chrome (he is already signed in; all his channels are under one Google account).
Do NOT change anything else on these videos or channels (title, description, visibility, etc.).
If YouTube asks to sign in, stop and tell Brian. Never type passwords.

## Shorts (video id, title)
${rows}

## Steps
1. In YouTube Studio, open the account menu (top-right avatar) -> Switch account -> pick **${this.owner.name}** (${this.owner.handle}).
2. For each video id: open https://studio.youtube.com/video/<id>/edit -> click **Show advanced settings** ->
   under Collaboration click **Invite a collaborator** (or **Manage collaborators**).
   - If the list already shows Chaosity as **Active collaborator**: click Cancel; it's done (write it to the done file).
   - If it shows **Pending acceptance**: click Cancel and go to step 3 for it.
   - Otherwise search **${MAIN.handle}**, pick the verified Chaosity result (${MAIN.handle}, about 152K subscribers),
     click **Create link**, close the "Copy and share your invite link" popup, then click **Save** ("Changes saved").
3. Switch account to **Chaosity** (${MAIN.handle}). For each invited video open
   https://studio.youtube.com/channel/${MAIN.id}/videos/upload?d=acd&v=<id> and click **Accept** in "You're invited to collaborate".
4. After each video is accepted (or was already active), append one line with just its video id to:
   ${this.doneFile}
5. Close the Chrome tabs you opened and give Brian a one-line summary.
${relSection}${laySection}`;
  }
}

/**
 * Turns iHatePosting posts into live YouTube video ids, newest first. postIds: [{ postId, title }] (queue order, newest last).
 * cache (saved in collab.json) remembers each post's video id, so each post is looked up until it's live, then never again.
 * Only shorts that went live in the last 7 days count (older ones were before this feature; Brian added some by hand).
 */
async function liveYouTubeVideos(postIds, getPost, cache) {
  const out = [], WEEK = 7 * 864e5;
  let lookups = 0;
  for (const p of [...postIds].reverse()) {
    const c = cache[p.postId];
    if (c && c.videoId) { if (Date.now() - c.liveAt < WEEK) out.push({ videoId: c.videoId, title: p.title }); continue; }
    if (c && c.old) continue;
    if (lookups >= 15) continue;
    lookups++;
    let post; try { post = await getPost(p.postId); } catch { continue; }
    if (!post) continue;
    for (const t of post.targets || []) {
      if (t.platform !== "youtube" || t.status !== "published" || !t.externalUrl) continue;
      const m = /[?&]v=([\w-]{11})|shorts\/([\w-]{11})|youtu\.be\/([\w-]{11})/.exec(t.externalUrl);
      if (!m) continue;
      const liveAt = Date.parse(t.publishedAt || post.publishedAt || post.scheduledAt) || Date.now();
      if (Date.now() - liveAt > WEEK) { cache[p.postId] = { old: true }; break; }
      cache[p.postId] = { videoId: m[1] || m[2] || m[3], liveAt };
      out.push({ videoId: cache[p.postId].videoId, title: p.title });
    }
    if (!cache[p.postId] && post.status && /fail|cancel|delet/i.test(post.status)) cache[p.postId] = { old: true };
  }
  return out;
}

/** Newest claude.exe from the Claude desktop app's bundled Claude Code (same place Video Studio looks). */
function findClaude() {
  const base = path.join(process.env.LOCALAPPDATA || "", "Claude-Data"); const found = [];
  try {
    for (const a of fs.readdirSync(base)) {
      const cc = path.join(base, a, "claude-code"); if (!fs.existsSync(cc)) continue;
      for (const v of fs.readdirSync(cc)) { const vd = path.join(cc, v); try { for (const h of fs.readdirSync(vd)) { const e = path.join(vd, h, "claude.exe"); if (fs.existsSync(e)) found.push({ e, t: fs.statSync(e).mtimeMs }); } } catch {} }
    }
  } catch {}
  found.sort((a, b) => b.t - a.t);
  return found.length ? found[0].e : null;
}

module.exports = { Collab, liveYouTubeVideos, findClaude };

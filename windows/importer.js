// The clip folder is the queue: every video in it gets posted. "Titles and Descriptions.csv" in the same folder says what
// each one is called and the order they go out in. The app adds a row for any new clip and keeps Status current.
// Time columns are made per linked account ("<account> Time"), so this works for whatever channel the iHatePosting account has.
const fs = require("fs"), { spawnSync } = require("child_process");
const { NC, KIT } = require("./config");
const TV = NC + "/TikTok versions", DONE = NC + "/Posted", PLAN = NC + "/Titles and Descriptions.csv";
const FFPROBE = KIT + "/tools/ffmpeg/bin/ffprobe.exe";
const timeCol = a => `${a.label} Time`;
const BASE_COLS = ["Post To", "Game", "Title", "Game Hashtag", "YouTube Description", "TikTok Caption", "YouTube Tags"];

const CONTRACT = { whos: "who's", im: "I'm", dont: "don't", thats: "that's", youre: "you're", didnt: "didn't", cant: "can't", wont: "won't", hes: "he's", shes: "she's", theres: "there's", whats: "what's", wasnt: "wasn't", isnt: "isn't", doesnt: "doesn't", ive: "I've", whyd: "why'd", weve: "we've", theyre: "they're", aint: "ain't", lets: "let's" };
const fixHook = s => s.replace(/\b[A-Za-z]+\b/g, w => { const c = CONTRACT[w.toLowerCase()]; if (!c) return w; return w[0] === w[0].toUpperCase() ? c[0].toUpperCase() + c.slice(1) : c; });
const isVideo = f => /\.(mp4|mov)$/i.test(f);

function duration(file) {
  const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8", windowsHide: true });
  return Math.round(parseFloat(r.stdout) * 10) / 10 || 0;
}

const hasTikTokVersion = file => fs.existsSync(`${TV}/${file}`);
const srcPath = (version, file) => version === "TikTok" ? `${TV}/${file}` : `${NC}/${file}`;
/** Everything has posted: its files go to Posted so the folder only shows what's still to come. Nothing is deleted. */
function movePosted(file) {
  fs.mkdirSync(DONE, { recursive: true });
  const free = name => { let p = `${DONE}/${name}`; for (let n = 2; fs.existsSync(p); n++) p = `${DONE}/${n} ${name}`; return p; };
  if (fs.existsSync(`${NC}/${file}`)) fs.renameSync(`${NC}/${file}`, free(file));
  if (fs.existsSync(`${TV}/${file}`)) fs.renameSync(`${TV}/${file}`, free("TikTok " + file));
}
/** A clip still being copied in must not be picked up. */
function settled(p) {
  try { const s = fs.statSync(p); if (!s.size || Date.now() - Math.max(s.mtimeMs, s.birthtimeMs, s.ctimeMs) < 60000) return false; fs.closeSync(fs.openSync(p, "r+")); return true; } catch { return false; }
}

function parseCSV(t) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell.replace(/\r$/, "")); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, "")); rows.push(row); }
  return rows;
}
const csvCell = v => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const decode = b => { const s = b.toString("utf8"); return (s.includes("�") ? b.toString("latin1") : s).replace(/^﻿/, ""); };

/** Excel turns 2026-11-09 10:00 into 11/9/2026 10:00 when it saves, so both are accepted, with or without AM/PM. */
function parseWhen(s) {
  let m = String(s).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?m?\.?$/i), y, mo, d, h, mi, ap;
  if (m) [, y, mo, d, h, mi, ap] = m;
  else { m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?m?\.?$/i); if (!m) return null; [, mo, d, y, h, mi, ap] = m; if (y.length === 2) y = "20" + y; }
  h = +h; mi = +mi; mo = +mo; d = +d;
  if (ap) { if (h < 1 || h > 12) return null; h = h % 12 + (/p/i.test(ap) ? 12 : 0); }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return { date: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`, min: h * 60 + mi };
}
const fmtWhen = w => (w ? `${w.date} ${String(Math.floor(w.min / 60)).padStart(2, "0")}:${String(w.min % 60).padStart(2, "0")}` : "");
const sameWhen = (a, b) => !!a && !!b && a.date === b.date && a.min === b.min;
const postTo = i => i.hasYT && i.hasTT ? "All" : i.hasYT ? "YouTube only" : "TikTok only";
function statusLabel(i, maxDur) {
  if (i.status === "posted") return "Posted";
  if (i.status === "scheduled") return "Scheduled";
  if (i.status === "partial") return "Uploading";
  if (i.status === "skipped") return "Skip";
  if (i.dur > maxDur && !i.allowLong) return "Too long";
  return "Waiting";
}

function applyPlan(queue, accounts) {
  if (!fs.existsSync(PLAN)) return;
  const rows = parseCSV(decode(fs.readFileSync(PLAN)));
  const col = {}; (rows[0] || []).forEach((h, n) => { col[h.trim()] = n; });
  if (col.File == null || col.Title == null) throw new Error(`"Titles and Descriptions.csv" lost its File or Title column, so the app isn't reading or changing it. Fix the header row.`);
  const byFile = new Map(queue.items.map(i => [i.file, i])), order = new Set();
  for (const r of rows.slice(1)) {
    const v = n => (col[n] == null ? "" : (r[col[n]] || "").trim());
    const i = byFile.get(v("File")); if (!i) continue;
    order.add(i);
    if (v("Title")) i.title = v("Title");
    if (v("Game")) i.game = v("Game");
    if (col["Game Hashtag"] != null) i.hash = v("Game Hashtag").replace(/^#/, "");
    if (v("YouTube Tags")) i.ytTags = v("YouTube Tags");
    i.custom = { ytDesc: v("YouTube Description"), ttCap: v("TikTok Caption") };
    if (i.status === "queued" || i.status === "skipped") {
      const p = v("Post To").toLowerCase();
      if (p) { i.hasYT = !p.startsWith("tiktok"); i.hasTT = !p.startsWith("youtube"); }
      if (/^skip/i.test(v("Status"))) i.status = "skipped"; else if (i.status === "skipped") i.status = "queued";
      if (/^post anyway/i.test(v("Status"))) i.allowLong = true;
    }
    if (i.status === "queued" || i.status === "skipped" || i.status === "partial") for (const a of accounts) {
      const name = timeCol(a); if (col[name] == null || i.posts?.[a.id]) continue;
      const cell = v(name), was = i.written?.[a.id];
      i.fixed = i.fixed || {};
      if (!cell) { if (was) delete i.fixed[a.id]; continue; }
      const when = parseWhen(cell);
      if (when && !sameWhen(when, was)) i.fixed[a.id] = when;
    }
  }
  queue.items = [...order, ...queue.items.filter(i => !order.has(i))];
}

/** Writes the file: next-up clips on top, finished ones below. Returns false if Excel has it locked; the app tries again later. */
function writePlan(queue, accounts, maxDur) {
  const rank = i => (i.status === "posted" ? 3 : i.status === "scheduled" ? 2 : i.status === "skipped" ? 1 : 0);
  const items = queue.items.map((i, n) => [i, n]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
  const lines = [["File", "Status", ...accounts.map(timeCol), ...BASE_COLS].map(csvCell).join(",")];
  for (const i of items) { const c = i.custom || {}; lines.push([i.file, statusLabel(i, maxDur), ...accounts.map(a => fmtWhen(i.sched?.[a.id] || i.fixed?.[a.id])), postTo(i), i.game, i.title, i.hash || "", c.ytDesc, c.ttCap, i.ytTags].map(csvCell).join(",")); }
  const text = "﻿" + lines.join("\r\n") + "\r\n";
  try {
    if (!(fs.existsSync(PLAN) && fs.readFileSync(PLAN, "utf8") === text)) { fs.writeFileSync(PLAN + ".tmp", text); fs.renameSync(PLAN + ".tmp", PLAN); }
    for (const i of items) i.written = Object.fromEntries(accounts.map(a => [a.id, i.sched?.[a.id] || i.fixed?.[a.id] || null]).filter(x => x[1]));
    return true;
  } catch { fs.rmSync(PLAN + ".tmp", { force: true }); return false; }
}

/** Finds new clips, reads the file, drops rows whose clip was removed from the folder. File name "Hook text (Game).mp4" fills Title + Game. */
function rescan(queue, accounts, { write = true, maxDur = 60 } = {}) {
  for (const d of [NC, TV, DONE]) fs.mkdirSync(d, { recursive: true });
  let error = null, readable = true;
  try { applyPlan(queue, accounts); } catch (e) { error = e.message; readable = false; }
  const files = fs.readdirSync(NC).filter(isVideo), here = new Set(files);
  queue.items = queue.items.filter(i => (i.status !== "queued" && i.status !== "skipped") || here.has(i.file));
  const have = new Set(queue.items.map(i => i.file));
  let added = 0;
  for (const file of files.filter(f => !have.has(f) && settled(`${NC}/${f}`))) {
    const dur = duration(`${NC}/${file}`); if (!dur) continue;
    const base = file.replace(/\.\w+$/, ""), m = base.match(/^(?:[A-Z]+ \d+ - )?(.*?)(?: \(([^)]*)\))?$/);
    const game = (m && m[2]) || "Other", title = fixHook(m ? m[1] : base);
    const hash = game === "Other" ? "" : game.toLowerCase().replace(/[^a-z0-9]/g, "");
    queue.items.push({ file, game, title, hash, ytTags: game === "Other" ? "gaming,shorts" : `${game.toLowerCase()},gaming,shorts`, hasYT: true, hasTT: true, dur, status: "queued", posts: {} });
    have.add(file); added++;
  }
  // A row typed into the file BEFORE its clip was picked up (e.g. a title with "?!", which file names can't hold) still counts.
  if (added && readable) { try { applyPlan(queue, accounts); } catch (e) { error = e.message; readable = false; } }
  if (write && readable) writePlan(queue, accounts, maxDur);
  return { added, error };
}

// Brian's shorts rule (Nov 4): YouTube "#shorts #funny #gaming #<game>", TikTok "#fyp #funny #gaming #<game>".
const captions = i => {
  const c = i.custom || {}, tag = i.hash ? ` #${i.hash}` : "";
  return {
    ytTitle: /#shorts/i.test(i.title) ? i.title.slice(0, 100) : `${i.title.slice(0, 92)} #shorts`,
    ytText: c.ytDesc || `${i.title} #shorts #funny #gaming${tag}`,
    ttText: c.ttCap || `${i.title} #fyp #funny #gaming${tag}`,
  };
};
module.exports = { rescan, captions, writePlan, parseWhen, movePosted, hasTikTokVersion, srcPath, NC, PLAN };

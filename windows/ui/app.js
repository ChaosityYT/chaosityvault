// Chaosity Vault window: same layout as Post Library (Schedule, Library, Queue, Published, Auto & Setup).
const $m = document.getElementById("m"), dlg = document.getElementById("dlg");
let tab = "schedule", accounts = {}, st = null, H = {};
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fileName = u => { try { return decodeURIComponent(u.split("/").pop()).replace(/_/g, " ").replace(/\.\w+$/, ""); } catch { return u; } };
const mb = b => (b / 1e6).toFixed(b < 1e7 ? 1 : 0) + " MB";
const dayName = d => new Date(d + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
const ask = t => confirm(t);
async function guard(fn, btn) { if (btn) btn.disabled = true; try { await fn(); } catch (e) { alert(e.message); } if (btn) btn.disabled = false; }

async function status() {
  [st, H] = await Promise.all([lib.status(), lib.hubInfo()]);
  const p = document.getElementById("autoPill");
  p.textContent = st.status === "Working" ? "Working..." : st.settings.auto ? "Auto ON" : "Auto OFF";
  p.className = "pill " + (st.stopReason ? "r" : st.settings.auto ? "g" : "");
  for (const a of st.accounts || []) accounts[a.id] = a.label;
}
function banners() {
  let h = "";
  if (!st.hasKey) h += `<div class="banner">Add this channel's iHatePosting API key to get started.<span class="sp"></span><button class="b p" onclick="tabTo('auto')">Open Setup</button></div>`;
  if (st.stopReason) h += `<div class="banner"><b>Stopped:</b> ${esc(st.stopReason)} <span class="sp"></span><button class="b" onclick="tabTo('auto')">Open Auto</button></div>`;
  if (st.signIn) h += `<div class="banner">Sign in to iHatePosting (the Chaosity Vault account) so published files can be deleted. <span class="sp"></span><button class="b p" onclick="signIn()">Sign in</button></div>`;
  else if (st.lastError && st.hasKey) h += `<div class="banner">${esc(st.lastError)}</div>`;
  return h;
}
async function signIn() { await guard(async () => { await lib.signIn(); await status(); render(); }); }

// ---- Schedule ----
function postRow(p, kind) {
  const t = p.targets[0] || {}, l = p.scheduledLocal || {};
  const when = kind === "published" ? new Date(p.publishedAt || p.scheduledAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : l.time;
  const err = p.targets.map(x => x.error).filter(Boolean).join("; ");
  return `<div class="post"><div class="t">${esc(when)}</div><div>${esc(t.platform === "youtube" ? "▶ YouTube" : t.platform === "tiktok" ? "♪ TikTok" : t.platform)}</div>
  <div><div class="c" title="${esc(p.baseContent)}">${esc(p.baseContent)}</div>${err ? `<div class="err">${esc(err)}</div>` : ""}</div>
  <div class="row" style="margin:0">
  ${kind === "published" ? (t.externalUrl ? `<button class="b" onclick="lib.open('${esc(t.externalUrl)}')">Open</button>` : "") : `
  ${p.status === "failed" || p.status === "partial" ? `<button class="b" onclick="retry('${p.id}',this)">Retry</button>` : ""}
  ${p.status === "scheduled" ? `<button class="b" onclick="move('${p.id}','${l.date}')">Move</button>` : ""}
  <button class="b d" onclick="delPost('${p.id}',this)">Remove</button>`}
  </div></div>`;
}
function grouped(posts, kind) {
  const days = {}; for (const p of posts) { const d = p.scheduledLocal?.date || (p.publishedAt || p.scheduledAt || "?").slice(0, 10); (days[d] = days[d] || []).push(p); }
  return Object.keys(days).sort(kind === "published" ? (a, b) => b.localeCompare(a) : undefined).map(d => `<div class="day">${esc(dayName(d))} · ${days[d].length} post${days[d].length === 1 ? "" : "s"}</div>` + days[d].sort((a, b) => kind === "published" ? (b.scheduledAt || "").localeCompare(a.scheduledAt || "") : (a.scheduledAt || "").localeCompare(b.scheduledAt || "")).map(p => postRow(p, kind)).join("")).join("");
}
async function viewSchedule() {
  if (!st.hasKey) return `<div class="empty">Your schedule shows here once the API key is saved.</div>`;
  const [sch, fail, part, pub] = await Promise.all([lib.posts("scheduled"), lib.posts("failed"), lib.posts("partial"), lib.posts("publishing")]);
  const bad = [...fail, ...part];
  return `<div class="row"><b>${sch.length}</b> scheduled${pub.length ? ` · ${pub.length} publishing now` : ""}<span class="sp"></span><button class="b" onclick="newPost()">New post</button><button class="b" onclick="render()">Refresh</button></div>
  ${bad.length ? `<div class="day" style="color:#ff8a8d">Failed</div>` + bad.map(p => postRow(p, "bad")).join("") : ""}
  ${sch.length ? grouped(sch, "scheduled") : `<div class="empty">Nothing is scheduled right now.</div>`}`;
}
async function delPost(id, b) { if (ask("Remove this post from the schedule? It won't go out. The file stays in the library.")) await guard(async () => { await lib.deletePost(id); render(); }, b); }
async function retry(id, b) { await guard(async () => { await lib.retry(id); render(); }, b); }
function move(id, date) {
  dlg.innerHTML = `<h3>Move post</h3><label>Date (Central time)</label><input type="date" id="mvD" value="${date}"><label>Time</label><input type="time" id="mvT" value="12:00"><div class="row" style="margin-top:14px"><span class="sp"></span><button class="b" onclick="dlg.close()">Cancel</button><button class="b p" id="mvGo">Move</button></div>`;
  dlg.showModal();
  document.getElementById("mvGo").onclick = e => guard(async () => { await lib.reschedule(id, document.getElementById("mvD").value, document.getElementById("mvT").value); dlg.close(); render(); }, e.target);
}

// ---- Library ----
async function viewLibrary() {
  if (!st.hasKey) return `<div class="empty">Your upload library shows here once the API key is saved.</div>`;
  const m = await lib.media();
  const u = m.usage, pct = Math.min(100, u.usedBytes / u.quotaBytes * 100);
  const cards = m.assets.map(a => `<div class="card">${a.kind === "video" ? `<video src="${esc(a.url)}" preload="metadata" controls></video>` : `<img src="${esc(a.url)}">`}
    <div class="i"><div class="n">${esc(fileName(a.url))}</div>${mb(a.sizeBytes)}${a.durationSec ? ` · ${Math.round(a.durationSec)} s` : ""}<br>${new Date(a.createdAt).toLocaleDateString()}</div>
    <div class="a"><button class="b" onclick="newPost('${a.id}')">Post</button><button class="b d" onclick="delMedia('${a.id}',this)">Delete</button></div></div>`).join("");
  return `<div class="row"><div class="bar"><i style="width:${pct}%"></i></div>${mb(u.usedBytes)} of ${mb(u.quotaBytes)} · ${m.assets.length} files<span class="sp"></span><button class="b p" onclick="add(this)">Add files</button><button class="b" onclick="render()">Refresh</button></div>
  ${m.assets.length ? `<div class="grid">${cards}</div>` : `<div class="empty">The library is empty.</div>`}`;
}
async function add(b) { await guard(async () => { await lib.addFiles(); render(); }, b); }
async function delMedia(id, b) { if (ask("Delete this file from the iHatePosting library? This can't be undone. Your copy on this PC is not touched.")) await guard(async () => { await lib.deleteMedia(id); render(); }, b); }

function newPost(mediaId) {
  const acc = Object.entries(accounts).map(([id, n]) => `<label style="display:inline-block;margin-right:10px"><input type="checkbox" class="pa" value="${id}" checked> ${esc(n)}</label>`).join("");
  dlg.innerHTML = `<h3>New post</h3><label>Media id</label><input type="text" id="npM" value="${esc(mediaId || "")}" style="width:100%"><label>Caption</label><textarea id="npT"></textarea>
  <label>YouTube title (needed for YouTube)</label><input type="text" id="npY" style="width:100%"><label>Accounts</label>${acc || '<span class="dim">No accounts yet</span>'}
  <label>Date and time (Central)</label><input type="date" id="npD"> <input type="time" id="npH" value="12:00">
  <div class="row" style="margin-top:14px"><span class="sp"></span><button class="b" onclick="dlg.close()">Cancel</button><button class="b p" id="npGo">Schedule</button></div>`;
  dlg.showModal();
  document.getElementById("npGo").onclick = e => guard(async () => {
    const v = id => document.getElementById(id).value, to = [...document.querySelectorAll(".pa:checked")].map(x => x.value);
    if (!to.length || !v("npT") || !v("npD")) throw new Error("Pick an account, a caption and a date.");
    const body = { text: v("npT"), platforms: to, action: "schedule", scheduledDate: v("npD"), scheduledTime: v("npH"), options: {} };
    if (v("npM")) body.mediaIds = [v("npM").trim()];
    if (to.some(id => /YouTube/.test(accounts[id]))) body.options.youtube = { ytTitle: v("npY") || v("npT").slice(0, 90), ytMadeForKids: "no", ytPrivacy: "public", ytCategory: "entertainment" };
    if (to.some(id => /TikTok/.test(accounts[id]))) body.options.tiktok = { tiktokPrivacy: "public", tiktokAllowComment: true, tiktokAllowDuet: true, tiktokAllowStitch: true };
    await lib.createPost(body); dlg.close(); tabTo("schedule");
  }, e.target);
}

// ---- Queue ----
async function viewQueue() {
  const q = await lib.queue(), max = st.settings.maxDur;
  const waiting = q.items.filter(i => i.status === "queued" || i.status === "skipped");
  const label = i => i.status === "skipped" ? `<span class="pill">Skip</span>` : i.dur > max && !i.allowLong ? `<span class="pill a">over ${max} s</span>` : `<span class="pill g">Waiting</span>`;
  const rows = waiting.map(i => `<tr><td style="width:55%"><input type="text" class="title" value="${esc(i.title)}" onchange="setItem(this,{title:this.value})" data-f="${esc(i.file)}"></td>
    <td>${esc(i.game)}</td><td style="white-space:nowrap">${i.dur} s</td><td>${label(i)}</td>
    <td style="white-space:nowrap">${i.dur > max ? `<button class="b" data-f="${esc(i.file)}" onclick="setItem(this,{allowLong:${!i.allowLong}})">${i.allowLong ? "Hold" : "Allow"}</button>` : ""}
    ${i.status === "skipped" ? `<button class="b" data-f="${esc(i.file)}" onclick="setItem(this,{status:'queued'})">Put back</button>` : `<button class="b d" data-f="${esc(i.file)}" onclick="setItem(this,{status:'skipped'})">Skip</button>`}</td></tr>`).join("");
  const sched = q.items.filter(i => i.status === "scheduled" || i.status === "partial");
  return `<div class="row"><b>${waiting.filter(i => i.status === "queued").length}</b> shorts waiting · ${sched.length} scheduled by the app<span class="sp"></span><button class="b" onclick="lib.openPlan()">Open titles file</button><button class="b" onclick="lib.openFolder()">Open Chaosity Vault Uploads</button><button class="b" onclick="rescan(this)">Find new clips</button><button class="b" onclick="preview(this)">Preview next posts</button></div>
  ${waiting.length ? `<div class="box" style="padding:4px 8px"><table><tr><th>Title</th><th>Game</th><th>Length</th><th>Status</th><th></th></tr>${rows}</table></div>` : `<div class="empty">No clips waiting. Put finished shorts in Edited\\Chaosity Vault Uploads (name them "Title (Game).mp4").</div>`}
  ${sched.length ? `<div class="day">Scheduled by the app</div><div class="box" style="padding:4px 8px"><table>${sched.map(i => `<tr><td>${esc(i.title)}</td><td>${esc(i.game)}</td><td>${Object.values(i.sched || {}).map(w => `${w.date} ${String(Math.floor(w.min / 60)).padStart(2, "0")}:${String(w.min % 60).padStart(2, "0")}`).join(", ")}</td></tr>`).join("")}</table></div>` : ""}`;
}
async function setItem(el, patch) { await guard(async () => { await lib.setItem(el.dataset.f, patch); if (!("title" in patch)) render(); }); }
async function rescan(b) { await guard(async () => { const n = await lib.rescan(); alert(n + " new clips added to the queue."); render(); }, b); }
async function preview(b) { await guard(async () => { const lines = await lib.preview(); dlg.innerHTML = `<h3>What the next run would do</h3><div class="log">${lines.map(esc).join("\n") || "Nothing to schedule right now."}</div><div class="row" style="margin-top:14px"><span class="sp"></span><button class="b" onclick="dlg.close()">Close</button></div>`; dlg.showModal(); }, b); }

// ---- Published ----
async function viewPublished() {
  if (!st.hasKey) return `<div class="empty">Published posts show here once the API key is saved.</div>`;
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const p = await lib.posts("published", from);
  return `<div class="row"><b>${p.length}</b> published in the last 7 days<span class="sp"></span><button class="b" onclick="render()">Refresh</button></div>${grouped(p, "published") || `<div class="empty">Nothing yet.</div>`}`;
}

// ---- Auto & Setup ----
async function viewAuto() {
  const co = await lib.collabStatus().catch(() => null);
  const s = st.settings, logs = await lib.logs();
  const acc = (st.accounts || []).map(a => `<span class="chip ${s.accounts[a.id] === false ? "" : "on"}" onclick="toggleAcc('${a.id}', ${s.accounts[a.id] === false})">${esc(a.label)} · ${a.cap}/day</span>`).join("") || `<span class="dim">${st.hasKey ? "No YouTube/TikTok account found on this iHatePosting account yet." : "Shows up after the key is saved."}</span>`;
  const key = st.hasKey ? `<span class="pill g">API key saved</span><span class="dim">Encrypted on this PC${H.vault ? " and backed up in your hub vault" : ""}.</span><button class="b" onclick="replaceKey()">Replace key</button>`
    : `<span class="pill r">No API key</span><input type="text" id="key" placeholder="Paste this account's iHatePosting API key" style="min-width:320px" autocomplete="off"><button class="b p" onclick="saveKey(this)">Save key</button>`;
  const hub = H.connected ? `<span class="pill g">Hub connected</span><span class="dim">${H.vault ? "Vault unlocked." : "Vault locked."} ${H.lastSync ? "Synced " + new Date(H.lastSync).toLocaleTimeString() : ""}</span>${H.error ? `<span class="err">${esc(H.error)}</span>` : ""}<span class="sp"></span>${H.vault ? "" : `<input type="text" id="hubPass" placeholder="Vault passphrase" autocomplete="off"><button class="b" onclick="hubConnect(this,true)">Unlock vault</button>`}<button class="b" onclick="hubOff()">Disconnect</button>`
    : `<span class="pill a">Hub not connected</span><input type="text" id="hubKey" placeholder="Device key (hub_...)" autocomplete="off"><input type="text" id="hubPass" placeholder="Vault passphrase" autocomplete="off"><button class="b p" onclick="hubConnect(this)">Connect hub</button>`;
  return `<div class="box"><h3>Keep things going automatically</h3>
   <div class="row"><button class="b ${s.auto ? "" : "p"}" onclick="setS({auto:${!s.auto}})">${s.auto ? "Turn auto schedule OFF" : "Turn auto schedule ON"}</button>
   <button class="b" onclick="lib.runNow()">Run now</button>
   ${st.lastTick ? `<span class="dim">Last check ${new Date(st.lastTick).toLocaleTimeString()}</span>` : ""}</div>
   <div class="dim">When the app opens, when the PC wakes, and every ${s.tickMin} minutes: it reads ${esc(st.folder)} and its titles file, deletes library files whose posts have all published, then uploads and schedules the next clips in the file's order. It stops and alerts you on any limit or account message.</div></div>
  <div class="box"><h3>Setup (the Chaosity Vault iHatePosting account, separate from Post Library)</h3>
   <div class="row">${key}</div>
   <div class="row">${hub}</div>
   <div class="row"><span class="pill ${st.signInOk ? "g" : st.signIn ? "r" : "a"}">${st.signInOk ? "Signed in" : st.signIn ? "Signed out" : "Not signed in yet"}</span><button class="b" onclick="signIn()">${st.signInOk ? "Sign in again" : "Sign in to iHatePosting"}</button><span class="dim">Needed only to delete published files from the library.</span></div></div>
  ${co ? `<div class="box"><h3>Collab: your main channel on every Vault short</h3>
   <div class="row"><span class="pill ${!co.enabled ? "a" : co.pending ? "a" : "g"}">${!co.enabled ? "Off" : co.running ? "Claude is working…" : co.pending ? co.pending + " waiting" : "All done"}</span>
   <button class="b ${co.pending ? "p" : ""}" onclick="lib.collabRun().then(render)">Do collabs now (opens Claude)</button>
   <button class="b" onclick="lib.collabCheck().then(render)">Check again</button>
   <button class="b" onclick="lib.collabSet(${!co.enabled}).then(render)">${co.enabled ? "Turn off" : "Turn on"}</button>
   <span class="dim">${co.done} done</span></div>
   <div class="dim">Shorts only. Runs by itself 3 minutes after the app starts and then every hour (never while OBS is open): when Vault shorts are waiting, Claude adds @ChaosityYouTube as a collaborator in your normal Chrome (opening it minimized if needed) and accepts it as your main channel. The button runs it now in a window you can watch.${co.pendingTitles && co.pendingTitles.length ? "<br>Waiting: " + co.pendingTitles.map(esc).join(" · ") : ""}${co.last ? "<br>Last: " + esc(co.last) : ""}</div></div>` : ""}
  <div class="box"><h3>Rules</h3><div class="chips" style="margin-bottom:10px">${acc}</div>
   <div class="row"><label style="margin:0"><input type="checkbox" ${s.autoDelete ? "checked" : ""} onchange="setS({autoDelete:this.checked})"> Delete files after every post using them has published</label></div>
   <div class="row">Library budget <input type="number" style="width:80px" value="${s.budgetMB}" onchange="setS({budgetMB:+this.value})"> MB · Longest short <input type="number" style="width:70px" value="${s.maxDur}" onchange="setS({maxDur:+this.value})"> s · Schedule ahead <input type="number" style="width:60px" value="${s.horizonDays}" onchange="setS({horizonDays:+this.value})"> days</div>
   <div class="dim">Daily limits are fixed at 9 per YouTube channel and 12 per TikTok account.</div></div>
  <div class="box"><h3>Activity</h3><div class="log">${logs.map(esc).join("\n") || "Nothing yet."}</div></div>`;
}
async function setS(p) { await guard(async () => { await lib.setSettings(p); await status(); render(); }); }
async function toggleAcc(id, on) { await guard(async () => { await lib.setAccount(id, on); render(); }); }
async function saveKey(b) { const k = (document.getElementById("key").value || "").trim(); if (!k) return alert("Paste the key first."); await guard(async () => { await lib.setKey(k); render(); }, b); }
async function replaceKey() { if (ask("Remove the saved key so you can paste a new one?")) { await lib.clearKey(); render(); } }
async function hubConnect(b, passOnly) {
  const key = passOnly ? "" : (document.getElementById("hubKey")?.value || "").trim(), pass = document.getElementById("hubPass")?.value || "";
  if (!passOnly && !key) return alert("Paste the device key from your hub page first.");
  await guard(async () => { const r = await lib.hubConnect(key, pass); if (r.keyResult === "loaded") alert("Loaded this channel's iHatePosting key from your vault."); render(); }, b);
}
async function hubOff() { if (ask("Disconnect from your hub on this PC? Nothing is deleted from the hub.")) { await lib.hubDisconnect(); render(); } }

// ---- shell ----
const views = { schedule: viewSchedule, library: viewLibrary, queue: viewQueue, published: viewPublished, auto: viewAuto };
let renderId = 0;
async function render() {
  const id = ++renderId;
  document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("on", b.dataset.t === tab));
  try {
    await status();
    const h = await views[tab]();
    if (id === renderId) $m.innerHTML = banners() + h;
  } catch (e) { if (id === renderId) $m.innerHTML = banners() + `<div class="banner">${esc(e.message)}</div>`; }
}
function tabTo(t) { tab = t; $m.innerHTML = `<div class="empty">Loading...</div>`; render(); }
document.getElementById("nav").onclick = e => { if (e.target.dataset.t) tabTo(e.target.dataset.t); };
lib.onChanged(() => status().catch(() => {}));
render();

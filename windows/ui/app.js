const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let S = null, Q = null, H = {}, previewLines = null;
async function hubConnect(btn, passOnly) {
  const key = passOnly ? "" : ($("hubKey")?.value || "").trim(), pass = $("hubPass")?.value || "";
  if (!passOnly && !key) return alert("Paste the device key from your hub page first.");
  await busy(btn, async () => { const r = await lib.hubConnect(key, pass); if (r.keyResult === "loaded") alert("Loaded this channel's iHatePosting key from your vault."); });
  render();
}
async function hubOff() { if (confirm("Disconnect from your hub on this PC? (Nothing is deleted from the hub.)")) { await lib.hubDisconnect(); render(); } }

async function busy(btn, fn) { const t = btn.textContent; btn.disabled = true; try { await fn(); } catch (e) { alert(e.message); } btn.disabled = false; btn.textContent = t; }

function setupHtml() {
  const acc = S.accounts || [];
  const key = S.hasKey
    ? `<span class="pill g">API key saved</span><span class="dim">Encrypted on this PC.</span><button class="b" onclick="replaceKey()">Replace key</button>`
    : `<span class="pill r">No API key</span><input type="password" id="key" placeholder="Paste this account's iHatePosting API key"><button class="b p" onclick="saveKey(this)">Save key</button>`;
  const sign = S.signInOk
    ? `<span class="pill g">Signed in</span>`
    : `<span class="pill ${S.signIn ? "r" : "a"}">${S.signIn ? "Signed out" : "Not signed in yet"}</span><span class="dim">Sign in with this channel's iHatePosting account. Needed only to delete published files from the library.</span>`;
  const accs = acc.length
    ? acc.map(a => `<label class="row" style="gap:6px"><input type="checkbox" ${S.settings.accounts[a.id] === false ? "" : "checked"} onchange="lib.setAccount('${a.id}', this.checked)"> ${esc(a.label)} <span class="dim">(${a.cap}/day)</span></label>`).join("")
    : `<span class="dim">${S.hasKey ? "None found yet. Connect the channel on ihateposting.com, then press Run now." : "Shows up after the key is saved."}</span>`;
  const hub = H.connected
    ? `<span class="pill g">Hub connected</span><span class="dim">${H.vault ? "Key backed up in your vault." : "Vault not unlocked (add your passphrase to back up the key)."} ${H.lastSync ? "Last sync " + new Date(H.lastSync).toLocaleTimeString() : ""}</span>${H.error ? `<span class="err">${esc(H.error)}</span>` : ""}<span class="sp"></span>${H.vault ? "" : `<input type="password" id="hubPass" placeholder="Vault passphrase" style="min-width:200px"><button class="b" onclick="hubConnect(this,true)">Unlock vault</button>`}<button class="b" onclick="hubOff()">Disconnect</button>`
    : `<span class="pill a">Hub not connected</span><input type="password" id="hubKey" placeholder="Device key (hub_...)" style="min-width:220px"><input type="password" id="hubPass" placeholder="Vault passphrase" style="min-width:200px"><button class="b p" onclick="hubConnect(this)">Connect hub</button>
       <div class="dim" style="width:100%">On api.briangopaul.com/admin.php: Add a device, name "Brian PC - Chaosity Vault", project chaosityvault, "Can unlock my saved keys" ticked.</div>`;
  return `<h3>Setup <span class="dim" style="font-weight:400">(a separate iHatePosting account from your main Post Library)</span></h3>
  <div class="row">${key}</div>
  <div class="row" style="margin-top:8px">${hub}</div>
  <div class="row" style="margin-top:8px">${sign}<span class="sp"></span><button class="b" onclick="signIn(this)">Sign in to iHatePosting</button></div>
  <div class="row" style="margin-top:8px"><b>Posts to:</b> ${accs}</div>`;
}
function statusHtml() {
  const s = S.settings, t = S.lastTick ? new Date(S.lastTick).toLocaleString() : "never";
  const err = S.stopReason ? `<div class="err">Stopped: ${esc(S.stopReason)}</div>` : S.lastError ? `<div class="err">${esc(S.lastError)}</div>` : "";
  return `<div class="row"><b>${esc(S.status)}</b><span class="dim">Last run: ${esc(t)} · every ${s.tickMin} min · clips over ${s.maxDur}s wait (type "Post anyway" in Status) · library budget ${s.budgetMB} MB</span></div>
  <div class="dim">Clip folder: ${esc(S.folder)}</div>${err}`;
}
function queueHtml() {
  if (previewLines) return `<div class="log">${previewLines.length ? previewLines.map(esc).join("\n") : "Nothing would be scheduled right now."}</div><div style="margin-top:6px"><button class="b" onclick="previewLines=null;render()">Back to the list</button></div>`;
  const items = (Q.items || []).filter(i => i.status !== "posted");
  if (!items.length) return `<div class="dim">No clips yet. Put finished shorts in the clip folder (name them "Title (Game).mp4"), and they'll be posted in the titles file's order.</div>`;
  const label = { queued: "Waiting", scheduled: "Scheduled", partial: "Uploading", skipped: "Skip", dry: "Waiting" };
  return `<table><tr><th>Title</th><th>Game</th><th>Length</th><th>Status</th></tr>${items.map(i => `<tr><td>${esc(i.title)}</td><td>${esc(i.game)}</td><td>${i.dur}s</td><td>${label[i.status] || esc(i.status)}${i.status === "queued" && i.dur > S.settings.maxDur && !i.allowLong ? ' <span class="pill a">too long</span>' : ""}</td></tr>`).join("")}</table>`;
}
async function render() {
  [S, Q, H] = await Promise.all([lib.status(), lib.queue(), lib.hubInfo()]);
  $("name").textContent = S.accounts?.length ? `${S.name} · ${S.accounts.map(a => a.label).join(", ")}` : S.name;
  $("pill").innerHTML = S.settings.auto ? '<span class="pill g">Auto ON</span>' : '<span class="pill r">Auto OFF</span>';
  $("auto").textContent = S.settings.auto ? "Turn auto off" : "Turn auto on";
  $("setup").innerHTML = setupHtml(); $("statusBox").innerHTML = statusHtml(); $("queue").innerHTML = queueHtml();
  $("log").textContent = (await lib.logs()).join("\n");
  if (S.hasKey && !SCH && !schErr) loadSched(false); else if (!S.hasKey) renderSched();
}
async function saveKey(btn) { const k = $("key").value.trim(); if (!k) return alert("Paste the key first."); await busy(btn, () => lib.setKey(k)); render(); }
async function replaceKey() { if (confirm("Remove the saved key so you can paste a new one?")) { await lib.clearKey(); render(); } }
async function signIn(btn) { await busy(btn, () => lib.signIn()); render(); }
$("run").onclick = e => busy(e.target, () => lib.runNow());
$("auto").onclick = e => busy(e.target, () => lib.setSettings({ auto: !S.settings.auto }));
$("openPlan").onclick = () => lib.openPlan();
$("openFolder").onclick = () => lib.openFolder();
$("rescan").onclick = e => busy(e.target, async () => { await lib.rescan(); render(); });
$("preview").onclick = e => busy(e.target, async () => { e.target.textContent = "Checking..."; previewLines = await lib.preview(); render(); });
// ---- Schedule view ----
let SCH = null, schTab = "upcoming", schErr = null;
const TABS = { upcoming: "Upcoming", published: "Published (7 days)", failed: "Failed" };
const when = r => { const d = new Date(r.at); return isNaN(d) ? (r.local || "") : d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
function schedHtml() {
  if (!S?.hasKey) return `<div class="dim">Shows your scheduled and published posts once the API key is saved.</div>`;
  if (schErr) return `<div class="err">${esc(schErr)}</div>`;
  if (!SCH) return `<div class="dim">Loading...</div>`;
  const rows = SCH[schTab] || [];
  if (!rows.length) return `<div class="dim">${schTab === "upcoming" ? "Nothing scheduled right now." : schTab === "failed" ? "No failed posts." : "Nothing published in the last 7 days."}</div>`;
  return `<table><tr><th>${schTab === "upcoming" ? "Goes out" : "When"}</th><th>Account</th><th>Title</th><th></th></tr>${rows.map(r => `<tr><td style="white-space:nowrap">${esc(when(r))}</td><td style="white-space:nowrap">${esc(r.account)}</td><td>${esc(r.title)}${r.error ? `<div class="err">${esc(r.error)}</div>` : ""}</td><td style="white-space:nowrap">${
    schTab === "upcoming" ? `<button class="b" onclick="cancelPost('${r.id}', this)">Cancel</button>` :
    schTab === "failed" ? `<button class="b" onclick="retryPost('${r.id}', this)">Retry</button>` :
    r.url ? `<button class="b" onclick="lib.open('${esc(r.url)}')">Open</button>` : ""}</td></tr>`).join("")}</table>`;
}
function renderSched() {
  $("tabs").innerHTML = Object.entries(TABS).map(([k, v]) => `<button class="b${k === schTab ? " p" : ""}" onclick="schTab='${k}';renderSched()">${v}${SCH ? ` (${SCH[k].length})` : ""}</button>`).join(" ");
  $("sched").innerHTML = schedHtml();
}
async function loadSched(force) {
  if (!S?.hasKey) { SCH = null; renderSched(); return; }
  try { SCH = await lib.schedule(!!force); schErr = null; } catch (e) { schErr = e.message; }
  renderSched();
}
async function cancelPost(id, btn) { if (!confirm("Cancel this scheduled post? It won't go out. (The clip stays in your folder.)")) return; await busy(btn, () => lib.cancelPost(id)); loadSched(true); }
async function retryPost(id, btn) { await busy(btn, () => lib.retryPost(id)); loadSched(true); }
$("refreshSched").onclick = () => loadSched(true);
setInterval(() => loadSched(false), 120000);
setTimeout(() => loadSched(false), 500);
lib.onChanged(() => render());
render(); setInterval(render, 30000);

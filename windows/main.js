// Post Library 2: the same always-on shorts queue as Post Library, for ONE other channel on a SECOND iHatePosting account.
// Own tray icon, own data folder, own website sign-in and API key, own clip folder. It never reads the main app's key or files.
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, nativeImage, shell, powerMonitor, safeStorage } = require("electron");
const path = require("path"), fs = require("fs");
const { NAME, APP_ID, DATA, PARTITION } = require("./config");
const SHOT = process.env.PL2_SHOT; // dev only: screenshot the window to this file, then quit (no background work)
app.setPath("userData", SHOT ? DATA + " (screenshot)" : DATA); // keep everything (incl. the website session) apart from the main app
const { Engine } = require("./engine");
const { NC, PLAN } = require("./importer");
const { uiApi: api, setKeyProvider } = require("./api");
const { Hub } = require("./hub");

const SITE = "https://ihateposting.com";
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.exit(0);

let win, tray, engine, siteWin, quitting = false;
const startedVisible = process.argv.includes("--show");

// ---- secrets (iHatePosting key, hub device key, vault passphrase), encrypted with Brian's Windows sign-in ----
const SECRETS = path.join(DATA, "secrets.json");
const secret = {
  all() { try { return JSON.parse(fs.readFileSync(SECRETS, "utf8")); } catch { return {}; } },
  get(n) { const d = this.all(); try { return d[n] ? safeStorage.decryptString(Buffer.from(d[n], "base64")) : ""; } catch { return ""; } },
  set(n, v) { const d = this.all(); if (v) d[n] = safeStorage.encryptString(String(v)).toString("base64"); else delete d[n]; fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(SECRETS, JSON.stringify(d)); },
};
let keyCache = null;
const getKey = () => (keyCache != null ? keyCache : (keyCache = secret.get("apiKey")));
const setKey = k => { k = String(k || "").trim(); secret.set("apiKey", k); keyCache = k; };
setKeyProvider(getKey);
let hub;

function showWindow() { if (!win) createWindow(); if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
function title() { const a = engine?.state.accounts || []; return a.length ? `${NAME} - ${a.map(x => x.label).join(", ")}` : NAME; }
function createWindow() {
  win = new BrowserWindow({ width: 1000, height: 760, minWidth: 720, minHeight: 500, show: false, backgroundColor: "#0e0f12", title: title(), icon: path.join(__dirname, "ui/icon.png"), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false } });
  win.loadFile(path.join(__dirname, "ui/index.html"));
  win.on("page-title-updated", e => e.preventDefault());
  win.on("close", e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.on("minimize", () => win.hide());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: "deny" }; });
}

// ---- deleting library files needs the website sign-in (the API key can't) ----
const withTimeout = (p, ms, what) => { let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + " timed out")), ms); })]).finally(() => clearTimeout(t)); };
function dropSitePage() { try { if (siteWin && !siteWin.isDestroyed()) siteWin.destroy(); } catch {} siteWin = null; }
async function sitePage() {
  if (siteWin && !siteWin.isDestroyed()) return siteWin;
  siteWin = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, contextIsolation: true } });
  siteWin.webContents.setUserAgent(CHROME_UA);
  try { await withTimeout(siteWin.loadURL(SITE + "/guides"), 45000, "Opening the iHatePosting page"); } catch (e) { dropSitePage(); throw e; }
  return siteWin;
}
const pageFetch = async (js, what) => { const p = await sitePage(); try { return await withTimeout(p.webContents.executeJavaScript(js), 30000, what); } catch (e) { dropSitePage(); throw e; } };
const signedIn = async () => (await pageFetch(`fetch('/api/media?limit=1').then(r => r.status).catch(() => 0)`, "Sign-in check")) === 200;
async function deleteMedia(id) {
  if (!/^[a-z0-9]+$/i.test(id)) return { ok: false, status: 0 };
  let status = 0;
  try { status = await pageFetch(`fetch('/api/media/${id}', { method: 'DELETE' }).then(r => r.status).catch(() => 0)`, "Library delete"); } catch (e) { engine.log(e.message + "; will retry next run"); }
  return { ok: status >= 200 && status < 300, status, signedOut: status === 401 || status === 403 };
}
function openSignIn() {
  return new Promise(resolve => {
    const w = new BrowserWindow({ width: 520, height: 760, title: `Sign in to iHatePosting (${NAME})`, autoHideMenuBar: true, webPreferences: { partition: PARTITION, contextIsolation: true } });
    w.webContents.setUserAgent(CHROME_UA);
    w.webContents.setWindowOpenHandler(() => ({ action: "allow", overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { partition: PARTITION } } }));
    w.loadURL(SITE + "/media");
    w.on("closed", async () => { try { engine.state.signIn = !(await signedIn()); } catch { engine.state.signIn = true; } engine.state.signInOk = !engine.state.signIn; engine.save(); resolve(engine.state.signInOk); });
  });
}

// ---- notifications: silent while OBS is open ----
let obsCache = { at: 0, open: false };
function obsOpen() {
  if (Date.now() - obsCache.at < 15000) return Promise.resolve(obsCache.open);
  return new Promise(res => require("child_process").execFile("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true, timeout: 10000 }, (err, out) => { const open = !err && /"obs(64|32)?\.exe"/i.test(out || ""); obsCache = { at: Date.now(), open }; res(open); }));
}
async function notify(t, body) { if (!Notification.isSupported() || await obsOpen()) return; const n = new Notification({ title: t, body, icon: path.join(__dirname, "ui/icon.png") }); n.on("click", showWindow); n.show(); }
function watchActivity() {
  let scheduled = new Set(), live = 0, deleted = 0;
  const log = engine.log.bind(engine);
  engine.log = s => { log(s); let m; if ((m = /^Scheduled .*?\d{4}-\d\d-\d\d \d\d:\d\d: (.*)$/.exec(s))) scheduled.add(m[1]); else if (/^Posted everywhere: /.test(s)) live++; else if (/^Deleted from library \(published\)/.test(s)) deleted++; };
  const tick = engine.tick.bind(engine);
  engine.tick = async (...a) => {
    if (engine.running) return tick(...a);
    scheduled = new Set(); live = 0; deleted = 0;
    await tick(...a);
    if (win && !win.isDestroyed()) win.setTitle(title());
    const parts = [];
    if (live) parts.push(`${live} short${live === 1 ? "" : "s"} went live`);
    if (scheduled.size) parts.push(`${scheduled.size} new clip${scheduled.size === 1 ? "" : "s"} uploaded and scheduled`);
    if (deleted) parts.push(`${deleted} published file${deleted === 1 ? "" : "s"} deleted from the library`);
    if (parts.length) notify(NAME, parts.join(", ") + "." + (scheduled.size ? ` Next: ${[...scheduled][0]}` : ""));
  };
}
function refreshTray() {
  if (!tray) return;
  const s = engine.state.settings;
  tray.setToolTip(`${NAME} - auto ${s.auto ? "ON" : "OFF"}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `Open ${NAME}`, click: showWindow },
    { label: s.auto ? "Auto schedule: ON" : "Auto schedule: OFF", type: "checkbox", checked: s.auto, click: () => setSettings({ auto: !s.auto }) },
    { label: "Run now", click: () => engine.tick() },
    { type: "separator" },
    { label: "Quit (stops the background work)", click: () => { quitting = true; app.quit(); } },
  ]));
}
function setSettings(patch) {
  Object.assign(engine.state.settings, patch);
  if (patch.auto) engine.state.stopReason = null;
  engine.save(); engine.schedule(); refreshTray();
  if (patch.auto) engine.tick();
}

const wrap = fn => async (_e, ...a) => { try { return { ok: true, data: await fn(...a) }; } catch (err) { return { ok: false, error: err.message }; } };
function ipc() {
  const h = (n, f) => ipcMain.handle(n, wrap(f));
  h("status", () => ({ name: NAME, folder: NC, status: engine.status, settings: engine.state.settings, lastTick: engine.state.lastTick, lastError: engine.state.lastError, stopReason: engine.state.stopReason, signIn: engine.state.signIn, signInOk: !!engine.state.signInOk, hasKey: !!getKey(), accounts: engine.state.accounts }));
  h("setKey", async k => {
    const old = getKey(); setKey(k);
    try { await api.accounts(); } catch (e) { setKey(old); throw new Error("That key didn't work: " + e.message); }
    engine.log("API key saved."); setSettings({ auto: true });
    if (hub.enabled) await hub.syncKey().catch(e => engine.log("Couldn't save the key to your hub vault: " + e.message));
    return true;
  });
  // Schedule view: upcoming, published (last 7 days) and failed posts on this channel's account. Cached a minute (API limit).
  let sched = { at: 0, data: null };
  h("schedule", async force => {
    if (!getKey()) return null;
    if (!force && sched.data && Date.now() - sched.at < 60000) return sched.data;
    const label = Object.fromEntries((engine.state.accounts || []).map(a => [a.id, a.label]));
    const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const [up, pub, failed] = await Promise.all([api.posts("scheduled"), api.posts("published", from), api.posts("failed")]);
    const row = p => {
      const t = (p.targets || [])[0] || {}, acc = (engine.state.postInfo[p.id] || {}).acc || t.socialAccountId;
      const title = (engine.queue.items || []).find(i => Object.values(i.posts || {}).includes(p.id))?.title;
      return { id: p.id, status: p.status, at: p.publishedAt || p.scheduledAt, local: p.scheduledLocal ? `${p.scheduledLocal.date} ${p.scheduledLocal.time}` : null,
        account: label[acc] || (t.platform ? t.platform[0].toUpperCase() + t.platform.slice(1) : ""), title: title || (p.baseContent || "").slice(0, 90),
        url: (p.targets || []).map(x => x.externalUrl).find(Boolean) || null, error: (p.targets || []).map(x => x.error).find(Boolean) || null };
    };
    const by = k => (a, b) => (k * (Date.parse(a.at) - Date.parse(b.at)));
    sched = { at: Date.now(), data: { upcoming: up.map(row).sort(by(1)), published: pub.map(row).sort(by(-1)), failed: failed.map(row).sort(by(-1)) } };
    return sched.data;
  });
  h("cancelPost", async id => { await api.deletePost(id); sched.at = 0; engine.log("Cancelled a scheduled post from the Schedule view."); });
  h("retryPost", async id => { await api.retry(id); sched.at = 0; engine.log("Retried a failed post from the Schedule view."); });
  h("hubInfo", () => hub.info());
  h("hubConnect", async (key, pass) => { const r = await hub.connect(key, pass); if (getKey() && !engine.state.lastTick) engine.tick(); return r; });
  h("hubDisconnect", () => hub.disconnect());
  h("clearKey", () => { setKey(""); engine.log("API key removed."); });
  h("queue", () => engine.queue);
  h("setItem", (file, patch) => engine.setItem(file, patch));
  h("setAccount", (id, on) => { engine.state.settings.accounts[id] = !!on; engine.save(); });
  h("openFolder", () => { fs.mkdirSync(NC, { recursive: true }); return shell.openPath(NC); });
  h("openPlan", () => shell.openPath(PLAN));
  h("rescan", () => engine.rescan());
  h("setSettings", p => setSettings(p));
  h("runNow", () => { engine.tick(); });
  h("preview", async () => { // read-only: what WOULD be scheduled/deleted now
    const e = new Engine({ dry: true }); const lines = []; e.log = s => lines.push(s);
    e.queue = JSON.parse(JSON.stringify(engine.queue)); e.state = JSON.parse(JSON.stringify(engine.state)); e.state.settings.auto = true;
    await e.tick(); return lines;
  });
  h("logs", () => engine.logs());
  h("signIn", () => openSignIn());
  h("open", url => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
}

app.on("second-instance", (_e, argv) => { if (!argv.includes("--hidden")) showWindow(); engine?.runOnOpen(); });
app.on("window-all-closed", e => e.preventDefault?.());
app.on("before-quit", () => { quitting = true; });
app.whenReady().then(() => {
  if (!gotLock) return;
  app.setAppUserModelId(APP_ID);
  engine = new Engine({ deleteMedia, notify, onChange: () => { refreshTray(); if (win && !win.isDestroyed()) win.webContents.send("changed"); } });
  hub = new Hub({ secret, engine, getKey, setKey, setAuto: on => setSettings({ auto: on }), log: m => engine.log(m), onChange: () => { if (win && !win.isDestroyed()) win.webContents.send("changed"); }, stateFile: path.join(DATA, "hub.json") });
  ipc();
  watchActivity();
  if (!SHOT && hub.enabled) { hub.start(); hub.syncKey().then(r => { if (r === "loaded") engine.tick(); }).catch(e => engine.log("Hub vault: " + e.message)); }
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "ui/icon.png")).resize({ width: 16, height: 16 }));
  tray.on("click", showWindow); refreshTray();
  createWindow();
  // First run with no key yet (and none coming from the hub): open the window so the setup is obvious.
  if (startedVisible || (!getKey() && !hub.enabled)) win.once("ready-to-show", () => win.show());
  if (SHOT) { win.show(); setTimeout(async () => { fs.writeFileSync(SHOT, (await win.webContents.capturePage()).toPNG()); quitting = true; app.quit(); }, 4000); return; }
  engine.runOnOpen(); engine.start();
  powerMonitor.on("resume", () => setTimeout(() => engine.runOnOpen(), 30000));
});

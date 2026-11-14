// iHatePosting REST API for the SECOND iHatePosting account. The key is the one Brian pastes into this app's
// Setup screen; it's encrypted with his Windows sign-in (secrets.json in the app's data folder), never shown or logged.
const fs = require("fs"), path = require("path");
const BASE = "https://ihateposting.com";
const sleep = ms => new Promise(r => setTimeout(r, ms));
let keyFn = () => "";
const setKeyProvider = fn => { keyFn = fn; };
const key = () => { const k = keyFn(); if (!k) { const e = new Error("Add the iHatePosting API key for this account in Setup."); e.status = 0; e.noKey = true; throw e; } return k; };

let last = 0;
async function pace(gap) { if (!gap) return; const now = Date.now(), at = Math.max(now, last + gap); last = at; if (at > now) await sleep(at - now); }

class ApiError extends Error { constructor(status, msg, code) { super(msg); this.status = status; this.code = code; } }

async function call(method, url, body, gap = 2100) {
  await pace(gap); // API limit is 30 requests a minute
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(BASE + url, { method, headers: { Authorization: "Bearer " + key(), "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(90000) });
    if (r.status === 429 && attempt < 3) { await sleep(30000); continue; }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch {}
    if (!r.ok) throw new ApiError(r.status, (j && (j.error || j.message)) || `HTTP ${r.status}`, j && j.code);
    return j;
  }
}

const make = fast => { const R = fast ? 0 : 2100; return {
  accounts: () => call("GET", "/api/v1/accounts", null, R),
  media: () => call("GET", "/api/v1/media?limit=200", null, R),
  post: id => call("GET", "/api/v1/posts/" + id, null, R).then(r => r.post),
  async posts(status, from, to) {
    const out = []; let cursor = null;
    do {
      const q = new URLSearchParams({ limit: "200" });
      if (status) q.set("status", status); if (from) q.set("from", from); if (to) q.set("to", to); if (cursor) q.set("cursor", cursor);
      const r = await call("GET", "/api/v1/posts?" + q, null, R);
      out.push(...r.posts); cursor = r.hasMore ? r.nextCursor : null;
    } while (cursor);
    return out;
  },
  // Anything that creates or changes a post is paced 6 s apart (YouTube ban rule).
  create: body => call("POST", "/api/v1/posts", body, 6000),
  deletePost: id => call("DELETE", "/api/v1/posts/" + id, null, R),
  retry: id => call("POST", `/api/v1/posts/${id}/retry`, {}, 6000),
  reschedule: (id, scheduledDate, scheduledTime) => call("POST", `/api/v1/posts/${id}/reschedule`, { scheduledDate, scheduledTime }, 6000),
  async upload(file, label) {
    const bytes = fs.readFileSync(file);
    const mime = /\.mov$/i.test(file) ? "video/quicktime" : "video/mp4";
    label = label || path.basename(file);
    const p = await call("POST", "/api/v1/media/presign", { filename: label, mime, sizeBytes: bytes.length });
    const put = await fetch(p.uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: bytes, signal: AbortSignal.timeout(20 * 60000) }); // storage URL: never send the key there
    if (!put.ok) throw new ApiError(put.status, `Storage refused the upload (${put.status})`);
    const c = await call("POST", "/api/v1/media/confirm", { storageKey: p.storageKey, mime, label });
    return c.asset;
  },
}; };
module.exports = { api: make(false), uiApi: make(true), ApiError, sleep, setKeyProvider };

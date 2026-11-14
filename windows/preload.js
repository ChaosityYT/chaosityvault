const { contextBridge, ipcRenderer } = require("electron");
const call = async (n, ...a) => { const r = await ipcRenderer.invoke(n, ...a); if (!r.ok) throw new Error(r.error); return r.data; };
const names = ["status", "setKey", "clearKey", "queue", "setItem", "setAccount", "openFolder", "openPlan", "rescan", "setSettings", "runNow", "preview", "logs", "signIn", "open", "hubInfo", "hubConnect", "hubDisconnect", "schedule", "cancelPost", "retryPost", "accounts", "media", "posts", "deletePost", "reschedule", "retry", "createPost", "deleteMedia", "addFiles", "checkSignIn", "collabStatus", "collabSet", "collabRun", "collabCheck"];
contextBridge.exposeInMainWorld("lib", { ...Object.fromEntries(names.map(n => [n, (...a) => call(n, ...a)])), onChanged: f => ipcRenderer.on("changed", f) });

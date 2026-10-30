/**
 * The page conscious-mac serves on localhost: link the Mac with a QR, then every setting in one
 * place. One file, no build step and nothing from the internet; `nonce` lets its script and style
 * through the page's content security policy.
 */
export const page = (nonce: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conscious on this Mac</title>
<link rel="icon" href="data:,">
<style nonce="${nonce}">
:root { color-scheme: light dark; --bg: #f7f5f1; --card: #fff; --line: #e8e3da; --text: #1d1b18; --muted: #77716a;
  --accent: #1d1b18; --on-accent: #fff; --good: #2f8f5b; --warn: #b8742a; --bad: #c2453b; --soft: #f1ede6; }
@media (prefers-color-scheme: dark) { :root { --bg: #161513; --card: #1f1e1b; --line: #33302b; --text: #f1ede6;
  --muted: #a39d94; --accent: #f1ede6; --on-accent: #161513; --soft: #2a2824; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
main { max-width: 640px; margin: 0 auto; padding: 32px 20px 64px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; }
h1 { font-size: 22px; margin: 0; letter-spacing: -0.01em; }
h1 small { display: block; font-size: 13px; font-weight: 400; color: var(--muted); }
h2 { font-size: 15px; margin: 0 0 4px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 20px; margin: 14px 0; }
.hint { color: var(--muted); font-size: 13px; margin: 0 0 14px; }
.pill { font-size: 13px; padding: 4px 10px; border-radius: 999px; background: var(--soft); white-space: nowrap; }
.pill::before { content: "●"; margin-right: 6px; }
.pill.online::before { color: var(--good); } .pill.offline::before, .pill.connecting::before { color: var(--warn); }
.pill.unlinked::before, .pill.outdated::before { color: var(--bad); }
button, select, input { font: inherit; color: inherit; }
button { border: 1px solid var(--line); background: var(--card); border-radius: 10px; padding: 8px 14px; cursor: pointer; }
button.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
button.danger { color: var(--bad); }
button:disabled { opacity: 0.5; cursor: default; }
input, select { border: 1px solid var(--line); background: var(--bg); border-radius: 10px; padding: 8px 12px; min-width: 0; }
.row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.row input { flex: 1; }
.row + .row { margin-top: 10px; }
.folders { list-style: none; margin: 0 0 14px; padding: 0; }
.folders li { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-top: 1px solid var(--line); }
.folders li:first-child { border-top: 0; }
.folders .path { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grow { flex: 1; min-width: 0; }
.modes label { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 12px; margin: 8px 0; cursor: pointer; }
.modes label.on { border-color: var(--text); }
.modes small { display: block; color: var(--muted); }
.modes input { margin-top: 4px; }
.warning { color: var(--bad); font-size: 13px; margin-top: 4px; }
.qr { display: flex; gap: 20px; align-items: center; flex-wrap: wrap; }
.qr .code { width: 220px; height: 220px; background: #fff; border-radius: 12px; padding: 8px; }
.qr .code svg { width: 100%; height: 100%; display: block; }
.tabs { display: flex; gap: 6px; margin-bottom: 12px; }
.tabs button.on { background: var(--soft); border-color: var(--text); }
code { background: var(--soft); padding: 2px 6px; border-radius: 6px; font-size: 13px; }
.activity { list-style: none; margin: 0; padding: 0; }
.activity li { padding: 10px 0; border-top: 1px solid var(--line); font-size: 14px; }
.activity li:first-child { border-top: 0; }
.activity .meta { color: var(--muted); font-size: 12px; }
.error { color: var(--bad); font-size: 13px; margin: 8px 0 0; }
footer { color: var(--muted); font-size: 12px; margin-top: 24px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
</style>
</head>
<body>
<main id="app"><p class="hint">Loading…</p></main>
<script nonce="${nonce}">
"use strict";
const app = document.getElementById("app");
let state;
let shown = "";
let tab = "telegram";
let failure = "";
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const STATES = { online: "Online", connecting: "Connecting…", offline: "Offline, trying again", unlinked: "Not linked", outdated: "Needs an update", stopped: "Stopped" };
const MODES = [
  ["plan", "Read only", "Claude Code reads and answers, and changes nothing."],
  ["acceptEdits", "Edit files", "It edits files in these folders and runs what its settings allow. Anything else is refused."],
  ["bypassPermissions", "Full control", "It runs any command without asking."],
];
const MODELS = [["", "Claude Code's default"], ["opus", "Opus"], ["sonnet", "Sonnet"], ["haiku", "Haiku"]];

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong (" + response.status + ")");
  return data;
}

async function act(path, body) {
  failure = "";
  try { show(await api(path, body)); } catch (error) { failure = error.message; render(); }
}

function show(next) {
  state = next;
  const json = JSON.stringify(next);
  if (json === shown) return;
  shown = json;
  render();
}

function render() {
  if (!state) return;
  // Re-rendering must not lose what is being typed.
  const inputs = [...app.querySelectorAll("input[id]")].map((input) => [input.id, input.value, document.activeElement === input]);
  app.innerHTML = header() + (state.linked ? linked() : linking()) + (failure ? '<p class="error">' + esc(failure) + "</p>" : "") + footer();
  for (const [id, value, focused] of inputs) {
    const input = document.getElementById(id);
    if (!input) continue;
    input.value = value;
    if (focused) input.focus();
  }
}

function header() {
  const status = state.linked ? state.state : "unlinked";
  return '<header><h1>Conscious<small>on ' + esc(state.name) + "</small></h1>" +
    '<span class="pill ' + esc(status) + '">' + esc(STATES[status] || status) + "</span></header>";
}

function linking() {
  const offer = state.linking;
  if (!offer) {
    return '<section class="card"><h2>Link this Mac</h2>' +
      '<p class="hint">You will scan a code with your phone: it opens your chat with Conscious, and one tap links this Mac.</p>' +
      '<div class="row"><input id="server" placeholder="Your Conscious address, like https://conscious.example.com" value="' + esc(state.server) + '">' +
      '<button class="primary" data-act="link">Show the code</button></div></section>';
  }
  const chats = Object.keys(offer.qr);
  if (!chats.includes(tab)) tab = chats[0] || "";
  const tabs = chats.length > 1 ? '<div class="tabs">' + chats.map((chat) => '<button data-tab="' + chat + '" class="' + (chat === tab ? "on" : "") + '">' + (chat === "telegram" ? "Telegram" : "WhatsApp") + "</button>").join("") + "</div>" : "";
  const minutes = Math.max(0, Math.ceil((offer.expiresAt - Date.now()) / 60000));
  const code = tab ? '<div class="code">' + offer.qr[tab] + "</div>" : "";
  return '<section class="card"><h2>Scan this with your phone</h2>' +
    '<p class="hint">' + (tab ? "Point your phone's camera at the code: it opens " + (tab === "telegram" ? "Telegram" : "WhatsApp") + ". Tap Start or Send, and this page links by itself." : "Send the line below to Conscious from your phone.") + "</p>" +
    tabs + '<div class="qr">' + code + '<div class="grow"><p>Or send this in your chat with Conscious:</p><p><code>/mac ' + esc(offer.code) + "</code></p>" +
    '<p class="hint">' + (offer.error ? esc(offer.error) : "Works for " + minutes + " more minute" + (minutes === 1 ? "" : "s") + ".") + "</p>" +
    '<button data-act="cancel">Cancel</button></div></div></section>';
}

function linked() {
  const folders = state.folders.length
    ? '<ul class="folders">' + state.folders.map((folder) => '<li><div class="grow"><div>' + esc(folder.name) + '</div><div class="path">' + esc(folder.path) + '</div></div><button class="danger" data-remove="' + esc(folder.path) + '">Remove</button></li>').join("") + "</ul>"
    : '<p class="hint">No folder yet: Claude Code can do nothing until you add one.</p>';
  const hasHome = state.folders.some((folder) => folder.path === state.home);
  const modes = MODES.map(([mode, title, text]) => '<label class="' + (state.permissionMode === mode ? "on" : "") + '"><input type="radio" name="mode" value="' + mode + '"' + (state.permissionMode === mode ? " checked" : "") + "><span><strong>" + title + "</strong><small>" + text + "</small>" +
    (mode === "bypassPermissions" && state.permissionMode === mode ? '<span class="warning">Anything that gets Conscious to start a job can do anything on this Mac that you can, instructions hidden in a page or an email it reads included.</span>' : "") + "</span></label>").join("");
  const known = MODELS.some(([value]) => value === (state.model || ""));
  const models = (known ? MODELS : MODELS.concat([[state.model, state.model]])).map(([value, label]) => '<option value="' + esc(value) + '"' + ((state.model || "") === value ? " selected" : "") + ">" + esc(label) + "</option>").join("");
  const activity = state.activity.length
    ? '<ul class="activity">' + state.activity.map((job) => "<li>" + (job.result === "working" ? "⏳" : job.result === "answered" ? "✅" : "⚠️") + " " + esc(job.asked) +
      '<div class="meta">' + esc(new Date(job.startedAt).toLocaleString()) + " · " + esc(job.folder) + (job.readOnly ? " · read only" : "") + " · " + job.steps + " step" + (job.steps === 1 ? "" : "s") +
      (job.result === "working" && job.lastStep ? " · " + esc(job.lastStep) : "") + (job.reason ? " · " + esc(job.reason) : "") + "</div></li>").join("") + "</ul>"
    : '<p class="hint">Nothing yet. Ask Conscious to have Claude Code do something on your Mac.</p>';
  return '<section class="card"><h2>Folders Claude Code may work in</h2>' + folders +
    '<div class="row"><button class="primary" data-act="pick">Choose a folder…</button>' + (hasHome ? "" : '<button data-act="home">My whole home folder</button>') + "</div>" +
    '<div class="row"><input id="path" placeholder="or type a path, like ~/Projects/site"><button data-act="add">Add</button></div></section>' +
    '<section class="card"><h2>What Claude Code may do</h2><div class="modes">' + modes + "</div></section>" +
    '<section class="card"><h2>Model</h2><p class="hint">The Claude model for jobs from Conscious.</p><select id="model">' + models + "</select></section>" +
    '<section class="card"><h2>Activity</h2>' + activity + "</section>" +
    '<section class="card"><h2>Link</h2><p class="hint">Linked to ' + esc(state.server) + ". Unlinking stops Conscious from reaching this Mac.</p>" +
    '<div class="row"><button class="danger" data-act="unlink">Unlink this Mac</button><button class="danger" data-act="stop">Stop conscious-mac</button></div></section>';
}

function footer() {
  return "<footer><span>Claude Code: " + esc(state.claude.version || "not found") + " · " + esc(state.claude.path) + "</span><span>Log: " + esc(state.log) + "</span></footer>";
}

app.addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.dataset.tab) { tab = target.dataset.tab; render(); return; }
  if (target.dataset.remove) return act("/api/folders/remove", { path: target.dataset.remove });
  const action = target.dataset.act;
  if (action === "link") return act("/api/link", { server: document.getElementById("server").value.trim() });
  if (action === "cancel") return act("/api/link/cancel", {});
  if (action === "pick") return act("/api/folders/pick", {});
  if (action === "add") return act("/api/folders/add", { path: document.getElementById("path").value.trim() }).then(() => { const input = document.getElementById("path"); if (input && !failure) input.value = ""; });
  if (action === "home" && confirm("Let Claude Code work on every file in your home folder, keys and sign-ins included?")) return act("/api/folders/home", {});
  if (action === "unlink" && confirm("Unlink this Mac? Conscious will not reach it until you link it again.")) return act("/api/unlink", {});
  if (action === "stop" && confirm("Stop conscious-mac? It starts again with pnpm mac.")) {
    return api("/api/stop", {}).finally(() => { app.innerHTML = '<p class="hint">Stopped. Run <code>pnpm mac</code> in the Conscious folder to start it again.</p>'; clearInterval(timer); });
  }
});

app.addEventListener("change", (event) => {
  const target = event.target;
  if (target.name === "mode") {
    if (target.value === "bypassPermissions" && !confirm("Full control: Claude Code runs any command a job asks for, with nobody to stop it. Turn it on?")) { render(); return; }
    act("/api/settings", { permissionMode: target.value });
  }
  if (target.id === "model") act("/api/settings", { model: target.value });
});

app.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  if (event.target.id === "server") act("/api/link", { server: event.target.value.trim() });
  if (event.target.id === "path") document.querySelector('[data-act="add"]').click();
});

const refresh = () => api("/api/state").then(show).catch((error) => { failure = error.message; render(); });
const timer = setInterval(refresh, 1500);
refresh();
</script>
</body>
</html>
`;

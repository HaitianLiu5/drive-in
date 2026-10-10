// Server-rendered pages for owner sign-in and OAuth consent. Small and
// dependency-free; every value that came from a client is escaped.

export const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const STYLE = `
  :root { color-scheme: light dark; --bg: #f6f5f2; --fg: #1c1b19; --muted: #6b6860; --card: #fff; --accent: #2f5bea; --line: #e3e0d8; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121211; --fg: #ecebe6; --muted: #9c998f; --card: #1c1c1a; --accent: #7d9bff; --line: #2c2b28; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--fg);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 28px; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  p { margin: 8px 0; color: var(--muted); }
  strong { color: var(--fg); }
  label { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; color: var(--fg); }
  input[type=text], input[type=password] { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; font: inherit; }
  button { font: inherit; padding: 10px 16px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .row { display: flex; gap: 10px; margin-top: 18px; }
  .warn { color: #b4541a; }
  #status { min-height: 1.5em; }
`;

function page(title, body, { script = "" } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main>${script ? `<script type="module">${script}</script>` : ""}</body></html>`;
}

// Browser side of WebAuthn: base64url <-> ArrayBuffer around the JSON the
// server library speaks, so it works without PublicKeyCredential.parse*JSON.
const WEBAUTHN_SCRIPT = `
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const s64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
const status = document.getElementById("status");
const next = new URLSearchParams(location.search).get("next") || "/";
const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error?.message || res.statusText);
  return data;
}
async function register() {
  const initCode = document.getElementById("code")?.value || "";
  const options = await post("/auth/passkey/register/options", { initCode });
  options.challenge = b64(options.challenge);
  options.user.id = b64(options.user.id);
  options.excludeCredentials = (options.excludeCredentials || []).map((c) => ({ ...c, id: b64(c.id) }));
  const cred = await navigator.credentials.create({ publicKey: options });
  await post("/auth/passkey/register/verify", { response: {
    id: cred.id, rawId: s64(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment,
    response: { clientDataJSON: s64(cred.response.clientDataJSON), attestationObject: s64(cred.response.attestationObject),
      transports: cred.response.getTransports?.() || [] },
  } });
}
async function login() {
  const options = await post("/auth/passkey/login/options");
  options.challenge = b64(options.challenge);
  options.allowCredentials = (options.allowCredentials || []).map((c) => ({ ...c, id: b64(c.id) }));
  const cred = await navigator.credentials.get({ publicKey: options });
  await post("/auth/passkey/login/verify", { response: {
    id: cred.id, rawId: s64(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment,
    response: { clientDataJSON: s64(cred.response.clientDataJSON), authenticatorData: s64(cred.response.authenticatorData),
      signature: s64(cred.response.signature), userHandle: cred.response.userHandle ? s64(cred.response.userHandle) : undefined },
  } });
}
for (const [id, action] of [["register", register], ["login", login]]) {
  document.getElementById(id)?.addEventListener("click", async () => {
    status.textContent = "Waiting for your passkey…";
    try { await action(); location.href = safeNext; }
    catch (error) { status.textContent = error.message || String(error); }
  });
}
`;

export function loginPage({ hasPasskey }) {
  const body = hasPasskey
    ? `<h1>Sign in to Yolo</h1>
       <p>Yolo is your private media service. Use the passkey you set up on this account.</p>
       <div class="row"><button class="primary" id="login">Sign in with passkey</button></div>
       <p id="status"></p>
       <details><summary>Lost every passkey?</summary>
         <p>Rotate the <code>OWNER_INIT_CODE</code> secret, then enter the new code to register a passkey.</p>
         <input type="password" id="code" autocomplete="off" placeholder="Init code">
         <div class="row"><button id="register">Register a passkey</button></div>
       </details>`
    : `<h1>Set up Yolo</h1>
       <p>Enter the one-time init code from the <code>OWNER_INIT_CODE</code> Worker secret, then create a passkey. After this, the passkey is the only way to sign in.</p>
       <input type="password" id="code" autocomplete="off" placeholder="Init code">
       <div class="row"><button class="primary" id="register">Create passkey</button></div>
       <p id="status"></p>`;
  return page("Yolo sign-in", body, { script: WEBAUTHN_SCRIPT });
}

const SCOPE_LABELS = {
  read: "See what is playing, your devices, library, queue, playlists, and history",
  control: "Play, pause, seek, switch devices, and choose subtitles",
  manage: "Change your queue, playlists, history, and devices",
};

export function consentPage(details, handle) {
  const name = escapeHtml(details.clientName || "An app");
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const scopes = (details.scope?.length ? details.scope : Object.keys(SCOPE_LABELS)).map((scope) => `
    <label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked>
      <span><strong>${escapeHtml(scope)}</strong><br>${escapeHtml(SCOPE_LABELS[scope] || "")}</span></label>`).join("");
  return page(`Allow ${details.clientName || "app"}?`, `
    <h1>Allow ${name} to use Yolo?</h1>
    <p>${origin} Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
    ${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ""}
    <form method="post">
      <input type="hidden" name="handle" value="${escapeHtml(handle)}">
      ${scopes}
      <div class="row"><button class="primary" name="decision" value="approve">Allow</button>
        <button name="decision" value="deny">Deny</button></div>
    </form>`);
}

export function homePage({ signedIn, origin }) {
  return page("Yolo", `
    <h1>Yolo</h1>
    <p>Your private, agent-driven media service. Add <strong>${escapeHtml(origin)}/mcp</strong> as a remote MCP server in Claude or ChatGPT.</p>
    ${signedIn
      ? '<form method="post" action="/auth/logout"><div class="row"><button>Sign out</button></div></form>'
      : '<div class="row"><a href="/login"><button class="primary">Sign in</button></a></div>'}`);
}

export function messagePage(title, message, status = 400) {
  return new Response(page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`), {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

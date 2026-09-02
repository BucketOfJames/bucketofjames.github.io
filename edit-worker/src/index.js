// Cloudflare Worker: BucketOfJames site editor backend.
//
// Routes:
//   POST /api/login   { user, password } -> { ok:true, token, role }
//   POST /api/publish { token, about, manifestos[] } -> commits rendered HTML to repo
//
// Secrets (set via `wrangler secret put <NAME>`):
//   EDIT_USERS       - JSON object mapping usernames to { hash, role }
//                      e.g. { "boj": { "hash": "PBKDF2$...", "role": "admin" },
//                             "csy": { "hash": "PBKDF2$...", "role": "viewer" } }
//   EDIT_PASS_HASH   - (legacy fallback) PBKDF2 hash string for single admin user
//   EDIT_TOKEN_SECRET- long random secret used to sign/verify login tokens
//   GITHUB_TOKEN     - fine-grained PAT with Contents read+write on the repo
//   GITHUB_REPO      - "owner/repo" (e.g. "bucketofjames/bucketofjames.github.io")
//   GITHUB_BRANCH    - branch to write to (e.g. "main")
//
// Optional var (wrangler.jsonc "vars"):
//   ALLOWED_ORIGIN   - restrict CORS to this origin (default *)

import { renderMarkdown, htmlToMarkdown } from "./render.js";
import { verifyPassword, b64ToBytes } from "./verify.js";

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }
    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/api/publish" && request.method === "POST") {
      return handlePublish(request, env);
    }
    return json({ error: "Not found" }, 404, env);
  },
};

// ---------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------
function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(env),
    },
  });
}

// ---------------------------------------------------------------
// Login (PBKDF2 password check + signed token)
// ---------------------------------------------------------------
async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400, env);
  }
  const user = typeof body.user === "string" ? body.user : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!env.EDIT_TOKEN_SECRET) {
    return json({ error: "Worker not configured (missing secrets)" }, 500, env);
  }

  // Check multi-user secret first, fall back to legacy single-user secret.
  let passHash = null;
  let role = "admin";
  if (env.EDIT_USERS) {
    try {
      const users = JSON.parse(env.EDIT_USERS);
      if (users[user]) {
        passHash = users[user].hash;
        role = users[user].role || "admin";
      }
    } catch (e) { /* ignore malformed JSON */ }
  }
  if (!passHash && env.EDIT_USER && env.EDIT_PASS_HASH) {
    // Legacy single-user mode (backward compat for boj).
    if (user === env.EDIT_USER) {
      passHash = env.EDIT_PASS_HASH;
      role = "admin";
    }
  }

  if (!passHash || !(await verifyPassword(password, passHash))) {
    return json({ error: "Invalid username or password" }, 401, env);
  }

  const token = await signToken(user, role, env);
  return json({ ok: true, token, role }, 200, env);
}

// EDIT_PASS_HASH format: PBKDF2$<iterations>$<salt_b64>$<hash_b64>
// (verifyPassword + b64ToBytes + constantTimeEqual live in ./verify.js)

// Stateless signed token: base64url(header.payload) + "." + base64url(hmac)
// Payload format: "user.role.expiry" (new) or "user.expiry" (legacy, treated as admin).
async function signToken(user, role, env) {
  const payload = `${user}.${role}.${Date.now() + TOKEN_TTL_MS}`;
  const msg = b64url(new TextEncoder().encode(payload));
  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.EDIT_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(payload));
  return msg + "." + b64url(new Uint8Array(sig));
}

async function verifyToken(token, env) {
  if (!env.EDIT_TOKEN_SECRET || !token) return { ok: false };
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false };
  const msgB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let payload;
  try {
    payload = new TextDecoder().decode(b64urlToBytes(msgB64));
  } catch (e) {
    return { ok: false };
  }
  const parts = payload.split(".");
  const user = parts[0];
  // New format: user.role.expiry; legacy: user.expiry (admin by default).
  const role = parts.length >= 3 ? parts[1] : "admin";
  const expiryStr = parts[parts.length - 1];
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return { ok: false };

  const hmac = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.EDIT_TOKEN_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const ok = await crypto.subtle.verify(
    "HMAC",
    hmac,
    b64urlToBytes(sigB64),
    new TextEncoder().encode(payload)
  );
  return ok ? { ok: true, user, role } : { ok: false };
}

// ---------------------------------------------------------------
// Publish (render markdown -> HTML, replace markers in index.html + edit/index.html, commit)
// ---------------------------------------------------------------
async function handlePublish(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400, env);
  }
  const tokenResult = await verifyToken(body.token, env);
  if (!tokenResult.ok) {
    return json({ error: "Unauthorized" }, 401, env);
  }
  if (tokenResult.role !== "admin") {
    return json({ error: "Forbidden — this account cannot publish" }, 403, env);
  }
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO || !env.GITHUB_BRANCH) {
    return json({ error: "Worker not configured (missing GitHub secrets)" }, 500, env);
  }

  const aboutRaw = typeof body.about === "string" ? body.about : "";
  const manifestosRaw = Array.isArray(body.manifestos) ? body.manifestos.map(String) : [];

  // Normalize: convert any raw HTML to markdown before rendering.
  const about = htmlToMarkdown(aboutRaw);
  const manifestos = manifestosRaw.map(htmlToMarkdown);

  const aboutHtml = renderMarkdown(about);
  const manHtml = manifestos
    .map((m) => `\n<article class="manifestos-item">\n${renderMarkdown(m)}\n</article>`)
    .join("\n");

  try {
    // Fetch index.html to detect changes.
    const file = await getFile(env, "index.html");
    const updatedContent = replaceSections(file.content, aboutHtml, manHtml);
    if (updatedContent === file.content) {
      return json({ ok: true, changed: false, message: "No changes" }, 200, env);
    }

    // Generate edit/index.html defaults replacement.
    const editFile = await getFile(env, "edit/index.html");
    const { aboutDefaults, manifestosDefaults } = buildEditDefaultsReplacement(editFile.content, about, manifestos);

    // Trigger GitHub Actions workflow to commit with GPG signing.
    await triggerWorkflow(env, {
      aboutHtml,
      manHtml,
      editAboutDefaults: aboutDefaults,
      editManifestosDefaults: manifestosDefaults,
      msgIndex: "Update site content from editor",
      msgEdit: "Update editor defaults from publish",
    });

    return json({ ok: true, changed: true }, 200, env);
  } catch (err) {
    return json({ error: "Publish failed", detail: String(err) }, 500, env);
  }
}

async function getFile(env, path) {
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "bucket-editor-worker",
  };
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub get failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  if (data.type !== "file" || !data.content) {
    throw new Error(`${path} not found in repo`);
  }
  return { sha: data.sha, content: decodeBase64(data.content) };
}

async function triggerWorkflow(env, payload) {
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "bucket-editor-worker",
    "Content-Type": "application/json",
  };
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        event_type: "editor-publish",
        client_payload: payload,
      }),
    }
  );
  if (!res.ok) {
    throw new Error(`GitHub dispatch failed (${res.status}): ${await res.text()}`);
  }
}

const ABOUT_OPEN = "<!--about-content-->";
const ABOUT_CLOSE = "<!--/about-content-->";
const MAN_OPEN = "<!--manifestos-content-->";
const MAN_CLOSE = "<!--/manifestos-content-->";

function replaceSections(html, aboutHtml, manHtml) {
  let out = html;
  out = replaceBetween(out, ABOUT_OPEN, ABOUT_CLOSE, aboutHtml);
  out = replaceBetween(out, MAN_OPEN, MAN_CLOSE, manHtml);
  return out;
}

function replaceBetween(source, open, close, replacement) {
  const i = source.indexOf(open);
  if (i < 0) return source;
  const j = source.indexOf(close, i);
  if (j < 0) return source;
  const start = i + open.length;
  const before = source.slice(start, j);
  // Preserve the newline after the open marker for tidy output.
  const indent = /^\s*\n/.test(before) ? "\n" : "";
  return (
    source.slice(0, start) +
    indent +
    replacement +
    (/\n\s*$/.test(before) ? "\n" : "") +
    source.slice(j)
  );
}

// ---------------------------------------------------------------
// Build the replacement content for edit/index.html defaults.
// Returns the raw text to insert between the markers (excluding markers).
// ---------------------------------------------------------------
function buildEditDefaultsReplacement(_html, aboutMd, manifestos) {
  const indent = "          ";

  // --- About ---
  const aboutLines = aboutMd.split("\n");
  const aboutParts = [];
  for (let i = 0; i < aboutLines.length; i++) {
    let line = aboutLines[i];
    // Empty lines become "\n" so paragraph breaks survive the + concatenation.
    if (line === "") line = "\n";
    if (i < aboutLines.length - 1) {
      aboutParts.push(indent + jsString(line) + " +");
    } else {
      aboutParts.push(indent + jsString(line));
    }
  }
  const aboutDefaults = aboutParts.join("\n");

  // --- Manifestos ---
  const manParts = manifestos.map((m) => indent + jsString(m) + ",");
  const manifestosDefaults = manParts.join("\n");

  return { aboutDefaults, manifestosDefaults };
}

// Escape a string for use as a JavaScript "..." literal (double quotes, \n, \\).
function jsString(s) {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
}

// ---------------------------------------------------------------
// Base64 helpers (TextEncoder/TextDecoder safe for UTF-8)
// ---------------------------------------------------------------
function encodeBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function decodeBase64(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function b64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

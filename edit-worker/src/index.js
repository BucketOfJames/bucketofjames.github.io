// Cloudflare Worker: BucketOfJames site editor backend.
//
// Routes:
//   POST /api/login    { user, password } -> { ok:true, token, role }
//   POST /api/publish  { token, about, manifestos[] } -> renders, stages, dispatches
//   GET  /api/content  (Authorization: Bearer <token>) -> { ok, about, manifestos }
//                      Live content as markdown, derived from index.html.
//
// Publish pipeline (GitHub Pages + Actions, GPG-signed commits):
//   1. Verify token + admin role.
//   2. Normalize raw HTML -> markdown, render markdown -> HTML.
//   3. Fetch index.html from the GitHub API; if the marker regions are
//      unchanged, report "No changes".
//   4. Otherwise write the fully-assembled index.html to the
//      `editor-staging` branch (Contents API). This keeps the
//      repository_dispatch client_payload tiny (message only), immune to the
//      ~10 KB payload ceiling.
//   5. Fire repository_dispatch; the editor-publish workflow copies the
//      staged file to main in one GPG-signed commit.
//
// Secrets (set via `wrangler secret put <NAME>`):
//   EDIT_USERS       - JSON object mapping usernames to { hash, role }
//                      e.g. { "boj": { "hash": "PBKDF2$...", "role": "admin" },
//                             "csy": { "hash": "PBKDF2$...", "role": "viewer" } }
//   EDIT_PASS_HASH   - (legacy fallback) PBKDF2 hash string for single admin user
//   EDIT_TOKEN_SECRET- long random secret used to sign/verify login tokens
//   GITHUB_TOKEN     - fine-grained PAT with Contents read+write on the repo
//   GITHUB_REPO      - "owner/repo" (e.g. "bucketofjames/bucketofjames.github.io")
//   GITHUB_BRANCH    - branch the site lives on (default "main")
//
// Optional var (wrangler.jsonc "vars"):
//   ALLOWED_ORIGIN   - restrict CORS to this origin (default *)

import { renderMarkdown, htmlToMarkdown } from "../../shared/render.js";
import { verifyPassword } from "./verify.js";
import { json, corsHeaders } from "../../shared/http.js";
import { b64url, b64urlToBytes, encodeBase64, decodeBase64 } from "../../shared/base64.js";

const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const STAGING_BRANCH = "editor-staging";

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
    if (url.pathname === "/api/content" && request.method === "GET") {
      return handleContent(request, env);
    }
    return json({ error: "Not found" }, 404, env);
  },
};

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
// (verifyPassword + constantTimeEqual live in ./verify.js)

// Stateless signed token: base64url(payload) + "." + base64url(hmac)
// Payload: JSON { user, role, exp } (legacy "user.role.expiry" still accepted).
async function signToken(user, role, env) {
  const payload = JSON.stringify({ user, role, exp: Date.now() + TOKEN_TTL_MS });
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
  let user, role, expiry;
  try {
    const parsed = JSON.parse(payload);
    user = parsed.user;
    role = parsed.role || "admin";
    expiry = Number(parsed.exp);
  } catch (e) {
    // Legacy format: user.role.expiry (user.expiry = admin by default).
    const parts = payload.split(".");
    user = parts[0];
    role = parts.length >= 3 ? parts[1] : "admin";
    expiry = Number(parts[parts.length - 1]);
  }
  if (!user || !Number.isFinite(expiry) || Date.now() > expiry) return { ok: false };

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
// Content (live markdown, derived from the marker regions of index.html)
// ---------------------------------------------------------------
const ABOUT_OPEN = "<!--about-content-->";
const ABOUT_CLOSE = "<!--/about-content-->";
const MAN_OPEN = "<!--manifestos-content-->";
const MAN_CLOSE = "<!--/manifestos-content-->";

function extractSection(html, open, close) {
  const i = html.indexOf(open);
  if (i < 0) return "";
  const j = html.indexOf(close, i);
  if (j < 0) return "";
  return html.slice(i + open.length, j);
}

function extractManifestos(manHtml) {
  const out = [];
  const re = /<article class="manifestos-item">([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(manHtml)) !== null) out.push(m[1]);
  return out;
}

async function handleContent(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const tokenResult = await verifyToken(token, env);
  if (!tokenResult.ok) {
    return json({ error: "Unauthorized" }, 401, env);
  }
  try {
    const file = await getFile(env, "index.html");
    const aboutHtml = extractSection(file.content, ABOUT_OPEN, ABOUT_CLOSE);
    const manHtml = extractSection(file.content, MAN_OPEN, MAN_CLOSE);
    const manifestos = extractManifestos(manHtml).map((m) => htmlToMarkdown(m));
    return json({ ok: true, about: htmlToMarkdown(aboutHtml), manifestos }, 200, env);
  } catch (err) {
    return json({ error: "Failed to load content", detail: String(err) }, 500, env);
  }
}

// ---------------------------------------------------------------
// Publish (render markdown -> HTML, stage on editor-staging, dispatch workflow)
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
    .map((m) => `<article class="manifestos-item">\n${renderMarkdown(m)}\n</article>`)
    .join("\n\n");

  try {
    // Fetch index.html to detect changes.
    const file = await getFile(env, "index.html");
    const updatedContent = replaceSections(file.content, aboutHtml, manHtml);
    if (updatedContent === file.content) {
      return json({ ok: true, changed: false, message: "No changes" }, 200, env);
    }

    // Stage the fully-assembled index.html, then let the workflow commit it.
    await putStaging(env, updatedContent);
    await triggerWorkflow(env, { msg: "Update site content from editor" });

    return json(
      { ok: true, changed: true, live: { about, manifestos } },
      200,
      env
    );
  } catch (err) {
    return json({ error: "Publish failed", detail: String(err) }, 500, env);
  }
}

// ---------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------
function ghHeaders(env, extra) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "bucket-editor-worker",
    ...extra,
  };
}

async function getFile(env, path) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
  const res = await fetch(url, { headers: ghHeaders(env) });
  if (!res.ok) {
    throw new Error(`GitHub get failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  if (data.type !== "file" || !data.content) {
    throw new Error(`${path} not found in repo`);
  }
  return { sha: data.sha, content: decodeBase64(data.content) };
}

// Write the assembled index.html to the editor-staging branch.
// If the branch is missing, create it from main and retry once.
async function putStaging(env, content) {
  let res = await putStagingOnce(env, content);
  if (res.status === 404 || res.status === 422) {
    await createBranch(env, STAGING_BRANCH, env.GITHUB_BRANCH || "main");
    res = await putStagingOnce(env, content);
  }
  if (!res.ok) {
    throw new Error(`GitHub staging write failed (${res.status}): ${await res.text()}`);
  }
}

async function putStagingOnce(env, content) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/index.html`;
  const existing = await fetch(`${url}?ref=${STAGING_BRANCH}`, { headers: ghHeaders(env) });
  let sha = null;
  if (existing.ok) sha = (await existing.json()).sha;
  const body = {
    message: "Editor staging",
    content: encodeBase64(content),
    branch: STAGING_BRANCH,
  };
  if (sha) body.sha = sha;
  return fetch(url, {
    method: "PUT",
    headers: ghHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
}

async function createBranch(env, branch, fromBranch) {
  const refUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/git/ref`;
  const head = await fetch(`${refUrl}/heads/${branch}`, { headers: ghHeaders(env) });
  if (head.ok) return;
  const base = await fetch(`${refUrl}/heads/${fromBranch}`, { headers: ghHeaders(env) });
  if (!base.ok) throw new Error(`GitHub ref read failed (${base.status})`);
  const sha = (await base.json()).object.sha;
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/git/refs`, {
    method: "POST",
    headers: ghHeaders(env, { "Content-Type": "application/json" }),
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
  });
  if (!res.ok) throw new Error(`GitHub branch create failed (${res.status}): ${await res.text()}`);
}

async function triggerWorkflow(env, payload) {
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`,
    {
      method: "POST",
      headers: ghHeaders(env, { "Content-Type": "application/json" }),
      body: JSON.stringify({ event_type: "editor-publish", client_payload: payload }),
    }
  );
  if (!res.ok) {
    throw new Error(`GitHub dispatch failed (${res.status}): ${await res.text()}`);
  }
}

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
  // Preserve the region's surrounding whitespace exactly, so an unchanged
  // publish compares equal (idempotent from the very first save).
  const leadingWs = /^\s*/.exec(before)[0];
  const trailingWs = /\s*$/.exec(before.slice(leadingWs.length))[0];
  return (
    source.slice(0, start) +
    leadingWs +
    replacement +
    trailingWs +
    source.slice(j)
  );
}
// Cloudflare Worker: BucketOfJames site editor backend.
//
// Routes:
//   POST /api/login   { user, password } -> { ok:true, token }  (sets nothing)
//   POST /api/publish { token, about, manifestos[] } -> commits rendered HTML to repo
//
// Secrets (set via `wrangler secret put <NAME>`):
//   EDIT_USER        - the accepted username (e.g. "boj")
//   EDIT_PASS_HASH   - PBKDF2 hash string produced by generate-hash.mjs
//   EDIT_TOKEN_SECRET- long random secret used to sign/verify login tokens
//   GITHUB_TOKEN     - fine-grained PAT with Contents read+write on the repo
//   GITHUB_REPO      - "owner/repo" (e.g. "bucketofjames/bucketofjames.github.io")
//   GITHUB_BRANCH    - branch to write to (e.g. "main")
//
// Optional var (wrangler.jsonc "vars"):
//   ALLOWED_ORIGIN   - restrict CORS to this origin (default *)

import { renderMarkdown } from "./render.js";

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

  if (!env.EDIT_USER || !env.EDIT_PASS_HASH || !env.EDIT_TOKEN_SECRET) {
    return json({ error: "Worker not configured (missing secrets)" }, 500, env);
  }

  if (user !== env.EDIT_USER || !(await verifyPassword(password, env.EDIT_PASS_HASH))) {
    return json({ error: "Invalid username or password" }, 401, env);
  }

  const token = await signToken(user, env);
  return json({ ok: true, token }, 200, env);
}

// EDIT_PASS_HASH format: PBKDF2$<iterations>$<salt_b64>$<hash_b64>
async function verifyPassword(password, stored) {
  try {
    const [tag, iterStr, saltB64, hashB64] = stored.split("$");
    if (tag !== "PBKDF2") return false;
    const iterations = parseInt(iterStr, 10);
    const salt = b64ToBytes(saltB64);
    const expected = b64ToBytes(hashB64);
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt,
        iterations,
      },
      keyMaterial,
      expected.length * 8
    );
    const actual = new Uint8Array(bits);
    return constantTimeEqual(actual, expected);
  } catch (e) {
    return false;
  }
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Stateless signed token: base64url(header.payload) + "." + base64url(hmac)
async function signToken(user, env) {
  const payload = `${user}.${Date.now() + TOKEN_TTL_MS}`;
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
  if (!env.EDIT_TOKEN_SECRET || !token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const msgB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  let payload;
  try {
    payload = new TextDecoder().decode(b64urlToBytes(msgB64));
  } catch (e) {
    return false;
  }
  const [user, expiryStr] = payload.split(".");
  if (user !== env.EDIT_USER) return false;
  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;

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
  return ok;
}

// ---------------------------------------------------------------
// Publish (render markdown -> HTML, replace markers in index.html, commit)
// ---------------------------------------------------------------
async function handlePublish(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "Invalid JSON" }, 400, env);
  }
  if (!(await verifyToken(body.token, env))) {
    return json({ error: "Unauthorized" }, 401, env);
  }
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO || !env.GITHUB_BRANCH) {
    return json({ error: "Worker not configured (missing GitHub secrets)" }, 500, env);
  }

  const about = typeof body.about === "string" ? body.about : "";
  const manifestos = Array.isArray(body.manifestos) ? body.manifestos.map(String) : [];

  const aboutHtml = renderMarkdown(about);
  const manHtml = manifestos
    .map((m) => `\n<article class="manifestos-item">\n${renderMarkdown(m)}\n</article>`)
    .join("\n");

  try {
    const file = await getIndexHtml(env);
    const updated = replaceSections(file.content, aboutHtml, manHtml);
    if (updated === file.content) {
      return json({ ok: true, changed: false, message: "No changes" }, 200, env);
    }
    const commit = await putIndexHtml(env, file.sha, updated);
    return json(
      { ok: true, changed: true, sha: commit.sha, htmlUrl: commit.html_url },
      200,
      env
    );
  } catch (err) {
    return json({ error: "Publish failed", detail: String(err) }, 500, env);
  }
}

async function getIndexHtml(env) {
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "bucket-editor-worker",
  };
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/index.html`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`GitHub get failed (${res.status}): ${await res.text()}`);
  }
  const data = await res.json();
  if (data.type !== "file" || !data.content) {
    throw new Error("index.html not found in repo root");
  }
  return { sha: data.sha, content: decodeBase64(data.content) };
}

async function putIndexHtml(env, sha, content) {
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "bucket-editor-worker",
    "Content-Type": "application/json",
  };
  const body = {
    message: "Update site content from editor",
    content: encodeBase64(content),
    sha,
    branch: env.GITHUB_BRANCH,
  };
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/index.html`,
    { method: "PUT", headers, body: JSON.stringify(body) }
  );
  if (!res.ok) {
    throw new Error(`GitHub put failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
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

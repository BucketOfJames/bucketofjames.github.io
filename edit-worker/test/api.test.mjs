// Worker API harness — run with: node edit-worker/test/api.test.mjs
// Stubs global fetch and exercises login / content / publish through the real module.
import { readFileSync } from "node:fs";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import worker from "../src/index.js";

let failures = 0;
function check(cond, label, extra) {
  if (cond) { console.log("ok  -", label); return; }
  failures++;
  console.error("FAIL -", label);
  if (extra !== undefined) console.error("  got:", JSON.stringify(extra));
}

const INDEX = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

const env = {
  EDIT_TOKEN_SECRET: "test-secret",
  GITHUB_TOKEN: "ghp_test",
  GITHUB_REPO: "BucketOfJames/bucketofjames.github.io",
  GITHUB_BRANCH: "main",
  ALLOWED_ORIGIN: "https://bucketofjames.github.io",
};

const salt = randomBytes(16).toString("base64");
const hash = pbkdf2Sync("hunter2", Buffer.from(salt, "base64"), 100000, 32, "sha256").toString("base64");
env.EDIT_USERS = JSON.stringify({
  boj: { hash: `PBKDF2$100000$${salt}$${hash}`, role: "admin" },
  csy: { hash: `PBKDF2$100000$${salt}$${hash}`, role: "viewer" },
});

const calls = [];
let stagingBranchExists = false;
const jsonRes = (obj, status) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  calls.push({ url, method: opts.method || "GET" });
  if (url.includes("/contents/index.html") && !url.includes("ref=editor-staging")) {
    if (opts.method === "PUT") {
      const body = JSON.parse(opts.body || "{}");
      if (body.branch === "editor-staging") {
        if (!stagingBranchExists) return jsonRes({ message: "Not Found" }, 404);
        return jsonRes({ content: { sha: "newsha" } }, 201);
      }
    }
    return jsonRes({ type: "file", content: Buffer.from(INDEX).toString("base64") }, 200);
  }
  if (url.includes("/contents/index.html?ref=editor-staging")) {
    if (!stagingBranchExists) return jsonRes({ message: "Not Found" }, 404);
    return jsonRes({ type: "file", content: "x", sha: "abc123" }, 200);
  }
  if (url.includes("/dispatches")) return new Response(null, { status: 204 });
  if (url.includes("/git/refs") && opts.method === "POST") {
    stagingBranchExists = true;
    return jsonRes({ ref: "refs/heads/editor-staging", object: { sha: "newsha" } }, 201);
  }
  if (url.includes("/git/ref/heads/editor-staging")) {
    return stagingBranchExists ? jsonRes({ object: { sha: "abc" } }, 200) : jsonRes({ message: "Not Found" }, 404);
  }
  if (url.includes("/git/ref")) return jsonRes({ object: { sha: "deadbeef" } }, 200);
  return jsonRes({ message: "not stubbed: " + url }, 500);
};

async function signToken(payload, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Buffer.from(payload).toString("base64url") + "." + Buffer.from(sig).toString("base64url");
}

const future = String(Date.now() + 3600_000);
const adminTok = await signToken(`boj.admin.${future}`, env.EDIT_TOKEN_SECRET);
const viewerTok = await signToken(`csy.viewer.${future}`, env.EDIT_TOKEN_SECRET);
const badTok = await signToken(`boj.admin.${future}`, "wrong-secret");

// --- login ---
{
  const res = await worker.fetch(new Request("http://x/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "boj", password: "hunter2" }),
  }), env);
  const data = await res.json();
  check(res.status === 200 && data.ok && data.role === "admin", "login ok (admin)");
}
{
  const res = await worker.fetch(new Request("http://x/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: "boj", password: "wrong" }),
  }), env);
  check(res.status === 401, "login bad password -> 401");
}

// --- content ---
{
  calls.length = 0;
  const res = await worker.fetch(new Request("http://x/api/content", { headers: { Authorization: "Bearer " + adminTok } }), env);
  const data = await res.json();
  check(res.status === 200 && data.ok, "content ok");
  check(data.about.includes("guy you love to hate"), "content about is markdown");
  check(Array.isArray(data.manifestos) && data.manifestos.length === 11, "content manifestos count", data.manifestos && data.manifestos.length);
  check(data.manifestos[0] === "The people who hate me are proof that I'm doing the right thing.", "content manifesto #1 round-trips");
  check(data.manifestos[10].includes("*absolute absence*"), "content manifesto #11 em round-trips");
  check(!data.about.includes("<"), "content about has no raw html");
}
{
  const res = await worker.fetch(new Request("http://x/api/content", { headers: { Authorization: "Bearer " + badTok } }), env);
  check(res.status === 401, "content bad token -> 401");
}
{
  const res = await worker.fetch(new Request("http://x/api/content"), env);
  check(res.status === 401, "content no token -> 401");
}

// --- publish: unchanged content (exact live-content round-trip) ---
let liveAbout = "", liveMans = [];
{
  const res = await worker.fetch(new Request("http://x/api/content", { headers: { Authorization: "Bearer " + adminTok } }), env);
  const data = await res.json();
  liveAbout = data.about;
  liveMans = data.manifestos;
}
{
  calls.length = 0;
  const res = await worker.fetch(new Request("http://x/api/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: adminTok, about: liveAbout, manifestos: liveMans }),
  }), env);
  const data = await res.json();
  check(res.status === 200 && data.ok && data.changed === false, "publish unchanged -> changed:false", data);
  check(!calls.some((c) => c.method === "PUT"), "publish unchanged -> no staging write");
  check(!calls.some((c) => c.url.includes("/dispatches")), "publish unchanged -> no dispatch");
}

// --- publish: changed content -> stage + tiny dispatch ---
{
  calls.length = 0;
  stagingBranchExists = true;
  const res = await worker.fetch(new Request("http://x/api/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      token: adminTok,
      about: "Fresh about & more",
      manifestos: ["First", "Second **bold**"],
    }),
  }), env);
  const data = await res.json();
  check(res.status === 200 && data.ok && data.changed === true, "publish changed -> changed:true");
  const put = calls.find((c) => c.method === "PUT");
  check(!!put, "publish changed -> staging PUT issued");
  check(data.live && data.live.about === "Fresh about & more", "publish returns live markdown");
  const dispatch = calls.find((c) => c.url.includes("/dispatches"));
  check(!!dispatch, "publish changed -> dispatch issued");
  check(!data.live.about.includes("&amp;"), "publish live has no double-escaped entities");
}

// --- publish: staging branch missing -> created from main ---
{
  calls.length = 0;
  stagingBranchExists = false;
  const res = await worker.fetch(new Request("http://x/api/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: adminTok, about: "A", manifestos: ["B"] }),
  }), env);
  const data = await res.json();
  check(res.status === 200 && data.ok && data.changed === true, "publish with missing branch -> ok");
  check(calls.some((c) => c.url.includes("/git/refs") && c.method === "POST"), "branch created via refs API");
}

// --- publish: authz ---
{
  const res = await worker.fetch(new Request("http://x/api/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: viewerTok, about: "a", manifestos: [] }),
  }), env);
  check(res.status === 403, "publish viewer -> 403");
}
{
  const res = await worker.fetch(new Request("http://x/api/publish", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: badTok, about: "a", manifestos: [] }),
  }), env);
  check(res.status === 401, "publish bad token -> 401");
}

if (failures) { console.error("\n" + failures + " failure(s)"); process.exit(1); }
console.log("\nAll tests passed.");
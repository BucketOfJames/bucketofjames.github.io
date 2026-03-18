const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_NOW_PLAYING_URL =
  "https://api.spotify.com/v1/me/player/currently-playing";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (url.pathname === "/login") {
      return handleLogin(request, env);
    }

    if (url.pathname === "/callback") {
      return handleCallback(request, env);
    }

    if (url.pathname === "/now-playing") {
      return handleNowPlaying(env);
    }

    return htmlResponse(`
      <h1>Spotify worker is running</h1>
      <p>Use <code>/login</code> once to connect Spotify.</p>
      <p>Then use <code>/now-playing</code> from your website.</p>
    `);
  },
};

function corsHeaders(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function htmlResponse(body, status = 200, extraHeaders = {}) {
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Spotify Worker</title>
  <style>
    body {
      font-family: system-ui, sans-serif;
      max-width: 760px;
      margin: 40px auto;
      padding: 0 16px;
      line-height: 1.5;
      background: #111;
      color: #eee;
    }
    code, pre, textarea {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    pre, textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 12px;
      border-radius: 10px;
      border: 1px solid #333;
      background: #1b1b1b;
      color: #fff;
    }
    a { color: #1db954; }
  </style>
</head>
<body>
${body}
</body>
</html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        ...extraHeaders,
      },
    }
  );
}

function jsonResponse(data, env, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...corsHeaders(env),
    },
  });
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(";").map((p) => p.trim());
  for (const part of parts) {
    const [key, ...rest] = part.split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function escapeHtml(str) {
  return str
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function handleLogin(request, env) {
  if (!env.SPOTIFY_CLIENT_ID) {
    return htmlResponse("<h1>Missing SPOTIFY_CLIENT_ID secret</h1>", 500);
  }

  const url = new URL(request.url);
  const redirectUri = `${url.origin}/callback`;
  const state = crypto.randomUUID();

  const params = new URLSearchParams({
    client_id: env.SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "user-read-currently-playing",
    state,
    show_dialog: "true",
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`,
      "Set-Cookie": `spotify_state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const cookieState = parseCookie(request.headers.get("Cookie"), "spotify_state");

  if (error) {
    return htmlResponse(`<h1>Spotify authorization failed</h1><p>${escapeHtml(error)}</p>`, 400);
  }

  if (!code) {
    return htmlResponse("<h1>Missing authorization code</h1>", 400);
  }

  if (!state || !cookieState || state !== cookieState) {
    return htmlResponse("<h1>State mismatch</h1><p>Refresh /login and try again.</p>", 400);
  }

  const redirectUri = `${url.origin}/callback`;
  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);

  const tokenRes = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || !tokenData.refresh_token) {
    return htmlResponse(
      `<h1>Could not get refresh token</h1><pre>${escapeHtml(
        JSON.stringify(tokenData, null, 2)
      )}</pre>`,
      500
    );
  }

  return htmlResponse(
    `
      <h1>Refresh token acquired</h1>
      <p>Copy the token below.</p>
      <p>Then run:</p>
      <pre>npx wrangler secret put SPOTIFY_REFRESH_TOKEN</pre>
      <p>After pasting it, deploy again with:</p>
      <pre>npx wrangler deploy</pre>
      <textarea rows="8" readonly>${escapeHtml(tokenData.refresh_token)}</textarea>
    `,
    200,
    {
      "Set-Cookie": "spotify_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    }
  );
}

async function getAccessToken(env) {
  const basic = btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`);

  const tokenRes = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: env.SPOTIFY_REFRESH_TOKEN,
    }),
  });

  const tokenData = await tokenRes.json();

  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(tokenData)}`);
  }

  return tokenData.access_token;
}

async function handleNowPlaying(env) {
  if (
    !env.SPOTIFY_CLIENT_ID ||
    !env.SPOTIFY_CLIENT_SECRET ||
    !env.SPOTIFY_REFRESH_TOKEN
  ) {
    return jsonResponse(
      { error: "Missing one or more Spotify secrets in the Worker." },
      env,
      500
    );
  }

  try {
    const accessToken = await getAccessToken(env);

    const spotifyRes = await fetch(SPOTIFY_NOW_PLAYING_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (spotifyRes.status === 204) {
      return jsonResponse({ isPlaying: false }, env, 200);
    }

    if (!spotifyRes.ok) {
      const text = await spotifyRes.text();
      return jsonResponse(
        { error: "Spotify API error", detail: text },
        env,
        500
      );
    }

    const data = await spotifyRes.json();

    if (!data || !data.item) {
      return jsonResponse({ isPlaying: false }, env, 200);
    }

    const item = data.item;
    const isTrack = item.type === "track" || !item.type;

    const title = item.name || "";
    const artist = isTrack
      ? (item.artists || []).map((a) => a.name).join(", ")
      : "";
    const albumArtUrl = isTrack
      ? item.album?.images?.[0]?.url || ""
      : item.images?.[0]?.url || "";
    const trackUrl = item.external_urls?.spotify || "";

    return jsonResponse(
      {
        isPlaying: Boolean(data.is_playing),
        title,
        artist,
        albumArtUrl,
        trackUrl,
        progressMs: data.progress_ms || 0,
        durationMs: item.duration_ms || 0,
      },
      env,
      200
    );
  } catch (err) {
    return jsonResponse(
      { error: "Worker exception", detail: String(err) },
      env,
      500
    );
  }
}

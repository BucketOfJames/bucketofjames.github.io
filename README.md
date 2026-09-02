# bucketofjames.github.io

Personal website + site editor. Live at https://bucketofjames.github.io.

## Layout

| Path | What |
|---|---|
| `index.html` | The site: profile, Spotify widget (shadow DOM), specs page, manifestos |
| `edit/index.html` | The `/edit/` editor app (login, markdown editing, previews) |
| `shared/` | Code shared by the workers and the editor (`render.js` markdown engine, `base64.js`, `http.js`) |
| `edit-worker/` | Cloudflare Worker: login / publish / content API for the editor |
| `spotify-worker/` | Cloudflare Worker: `/now-playing` endpoint + per-minute cron cache |
| `.github/workflows/editor-publish.yml` | GPG-signed commit of staged content on `repository_dispatch` |

## Publish pipeline

```
editor Save → POST /api/publish (edit-worker)
  → render markdown → HTML, compare with live index.html markers
  → if changed: PUT index.html on `editor-staging` branch
  → repository_dispatch → workflow: GPG-signed commit to main → Pages rebuild
```

Content lives between marker comments in `index.html` (`<!--about-content-->`,
`<!--manifestos-content-->`); the editor's own defaults are synced from the
same source on every save via `//__ABOUT_START__` / `//__MANIFESTOS_START__`
markers in `edit/index.html`.

## Secrets

All stored via `wrangler secret put` / GitHub Actions secrets, never in the repo:

- **edit-worker**: `EDIT_USERS` (PBKDF2 hashes + roles), `EDIT_TOKEN_SECRET`,
  `GITHUB_TOKEN`, legacy `EDIT_PASS_HASH`/`EDIT_USER`
- **spotify-worker**: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`,
  `SPOTIFY_REFRESH_TOKEN`
- **workflow**: `EDITOR_GPG_PRIVATE_KEY`, `EDITOR_GPG_PASSPHRASE`

Generate hashes: `node edit-worker/generate-hash.mjs`.

## Deploy

```sh
cd edit-worker    && npx wrangler deploy
cd spotify-worker && npx wrangler deploy
```

## Tests

```sh
npm test          # render engine + worker API harnesses
```
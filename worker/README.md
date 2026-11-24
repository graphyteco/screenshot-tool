# Framer server (Cloudflare Worker)

The Screenshot Framer is a static page, and Notion's API can't be called from a browser, so this
small Worker sits between them and holds the Notion token. It only touches Relume's Screenshots
database and the help docs (Docs (Publish)) its rows link to.

Live at https://screenshot-framer-notion.wispy-salad-6555.workers.dev (Cloudflare account matt@graphytedesign.com).

## Endpoints (all need the `x-framer-passcode` header)

- `GET /api/shots`: every row in Screenshots, with its doc's title and key.
- `GET /api/shots/WHK-020`: one row, plus its settings file inline and its raw captures.
- `POST /api/shots/WHK-020/versions` (multipart: `image`, `settings`, `capture1…n`, `version`, `sourceUrl`, `changelog`):
  uploads `WHK-020_vN.jpg`, `WHK-020_vN.json` and the captures, then updates the row (Version, Captured, Status = Current,
  Image, Settings file, Source URL, Changelog entry). After that, any image in the linked doc whose file is named
  `WHK-020_v*` (the placeholder `WHK-020_v0.png` or an older version) is swapped for the new image.
- `GET /api/file?u=…`: passes a Notion file through, because Notion's file links have no CORS headers.

## Deploy

```
cd worker
npx wrangler login
npx wrangler secret put NOTION_TOKEN      # Matt's Notion personal access token
npx wrangler secret put FRAMER_PASSCODE   # any passphrase; the Framer asks for it once
npx wrangler deploy
```

Then, in the Framer, open "Connection" and enter the workers.dev address and the passcode.

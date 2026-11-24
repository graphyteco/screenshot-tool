// Screenshot Framer ↔ Relume Notion.
// A small Cloudflare Worker between the Framer (a static page) and Notion, because
// Notion's API can't be called from a browser and the token must not sit in the page.
//
// Secrets (wrangler secret put):  NOTION_TOKEN  Matt's Notion personal access token
//                                 FRAMER_PASSCODE  what the Framer sends in x-framer-passcode
// Vars (wrangler.toml):           SHOTS_DS, DOCS_DS, ALLOWED_ORIGINS
//
// It only ever touches the Screenshots data source and the help docs related to it.

const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2025-09-03';

export default {
  async fetch(req, env) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (!env.FRAMER_PASSCODE || req.headers.get('x-framer-passcode') !== env.FRAMER_PASSCODE) {
        return json({ error: 'Wrong or missing passcode' }, 401, cors);
      }
      const url = new URL(req.url);
      const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean); // api, shots, WHK-020, versions
      if (parts[0] !== 'api') return json({ error: 'Not found' }, 404, cors);

      if (req.method === 'GET' && parts[1] === 'shots' && parts.length === 2) {
        return json({ shots: await listShots(env) }, 200, cors);
      }
      if (req.method === 'GET' && parts[1] === 'shots' && parts.length === 3) {
        return json(await getShot(env, decodeURIComponent(parts[2])), 200, cors);
      }
      if (req.method === 'POST' && parts[1] === 'shots' && parts[3] === 'versions') {
        return json(await saveVersion(env, decodeURIComponent(parts[2]), await req.formData()), 200, cors);
      }
      if (req.method === 'GET' && parts[1] === 'file') {
        return proxyFile(url.searchParams.get('u'), cors);
      }
      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return json({ error: err.message || String(err) }, err.status || 500, cors);
    }
  },
};

// ─── Notion plumbing ───────────────────────────────────────────────────────────

async function notion(env, path, { method = 'GET', body, form } = {}) {
  const headers = { Authorization: `Bearer ${env.NOTION_TOKEN}`, 'Notion-Version': NOTION_VERSION };
  if (body) headers['Content-Type'] = 'application/json';
  let res;
  for (let attempt = 0; attempt < 4; attempt++) {
    res = await fetch(path.startsWith('http') ? path : NOTION + path, {
      method, headers, body: form || (body ? JSON.stringify(body) : undefined),
    });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Notion ${method} ${path.replace(NOTION, '')}: ${data.message || res.status}`);
    e.status = res.status === 404 ? 404 : 502;
    throw e;
  }
  return data;
}

const text = (rt) => (rt || []).map((t) => t.plain_text).join('');
const fileOf = (files) => {
  const f = (files || [])[0];
  if (!f) return null;
  return { name: f.name, url: f.type === 'external' ? f.external.url : f.file?.url };
};

function shotFromPage(p) {
  const pr = p.properties;
  const shot = {
    pageId: p.id,
    url: p.url,
    id: text(pr.ID?.title),
    docIds: (pr.Doc?.relation || []).map((r) => r.id),
    slot: text(pr.Slot?.rich_text),
    version: pr.Version?.number ?? 0,
    captured: pr.Captured?.date?.start || null,
    sourceUrl: pr['Source URL']?.url || '',
    changelog: text(pr['Changelog entry']?.rich_text),
    status: pr.Status?.select?.name || '',
    image: fileOf(pr.Image?.files),
    settings: fileOf((pr['Settings file']?.files || []).filter((f) => /\.json$/i.test(f.name))),
    captures: (pr['Settings file']?.files || []).filter((f) => /_capture\d+\./i.test(f.name))
      .map((f) => ({ name: f.name, url: f.type === 'external' ? f.external.url : f.file?.url }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    docBlock: pr['Doc block']?.url || '',
    edited: p.last_edited_time,
  };
  // The doc's title and Webflow status come in as rollups, so listing needs no extra Notion calls.
  const titles = pr['Doc title']?.rollup?.array || [];
  const statuses = pr['Doc status']?.rollup?.array || [];
  shot.docs = shot.docIds.map((docId, i) => ({
    id: docId,
    title: text(titles[i]?.title) || '(untitled doc)',
    status: statuses[i]?.select?.name || '',
    key: shot.id.split('-')[0],
    url: `https://www.notion.so/${docId.replace(/-/g, '')}`,
  }));
  return shot;
}

async function queryShots(env, filter) {
  const out = [];
  let cursor;
  do {
    const data = await notion(env, `/data_sources/${env.SHOTS_DS}/query`, {
      method: 'POST',
      body: { page_size: 100, start_cursor: cursor, filter, sorts: [{ property: 'ID', direction: 'ascending' }] },
    });
    out.push(...data.results.map(shotFromPage));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return out;
}

// ─── Routes ────────────────────────────────────────────────────────────────────

async function listShots(env) {
  return queryShots(env);
}

async function findShot(env, id) {
  const [shot] = await queryShots(env, { property: 'ID', title: { equals: id } });
  if (!shot) { const e = new Error(`No screenshot ${id} in the Screenshots database`); e.status = 404; throw e; }
  return shot;
}

async function getShot(env, id) {
  const shot = await findShot(env, id);
  // The settings file is small JSON: hand it over inline so the Framer can re-apply it.
  if (shot.settings?.url) {
    const res = await fetch(shot.settings.url);
    shot.settingsJson = res.ok ? await res.json().catch(() => null) : null;
  }
  return shot;
}

async function uploadFile(env, file, filename, contentType) {
  const up = await notion(env, '/file_uploads', { method: 'POST', body: { mode: 'single_part', filename, content_type: contentType } });
  const form = new FormData();
  form.append('file', new Blob([await file.arrayBuffer()], { type: contentType }), filename);
  await notion(env, `/file_uploads/${up.id}/send`, { method: 'POST', form });
  return up.id;
}

// Saves a new version: uploads image + settings and updates the row. Never touches the docs.
async function saveVersion(env, id, form) {
  const shot = await findShot(env, id);
  const image = form.get('image');
  const settings = form.get('settings');
  if (!image || !settings) { const e = new Error('Send both image and settings'); e.status = 400; throw e; }

  const version = Math.max(parseInt(form.get('version'), 10) || 0, (shot.version || 0) + 1);
  const base = `${id}_v${version}`;
  const imageType = image.type || 'image/jpeg';
  const ext = imageType === 'image/png' ? 'png' : 'jpg';
  const imageUpload = await uploadFile(env, image, `${base}.${ext}`, imageType);
  const settingsUpload = await uploadFile(env, settings, `${base}.json`, 'application/json');

  // Raw captures ride along with the settings file, so a shot can be re-edited (highlights, crop)
  // without taking it again: Settings file = [WHK-020_v3.json, WHK-020_v3_capture1.png, …]
  const settingsFiles = [{ type: 'file_upload', file_upload: { id: settingsUpload }, name: `${base}.json` }];
  for (let i = 1; form.get(`capture${i}`); i++) {
    const cap = form.get(`capture${i}`);
    const capType = cap.type || 'image/png';
    const capName = `${base}_capture${i}.${capType === 'image/jpeg' ? 'jpg' : capType === 'image/webp' ? 'webp' : 'png'}`;
    settingsFiles.push({ type: 'file_upload', file_upload: { id: await uploadFile(env, cap, capName, capType) }, name: capName });
  }

  const props = {
    Version: { number: version },
    Captured: { date: { start: new Date().toISOString().slice(0, 10) } },
    Status: { select: { name: 'Current' } },
    Image: { files: [{ type: 'file_upload', file_upload: { id: imageUpload }, name: `${base}.${ext}` }] },
    'Settings file': { files: settingsFiles },
  };
  const sourceUrl = form.get('sourceUrl');
  if (sourceUrl) props['Source URL'] = { url: String(sourceUrl) };
  const changelog = form.get('changelog');
  if (changelog) props['Changelog entry'] = { rich_text: [{ text: { content: String(changelog).slice(0, 2000) } }] };
  await notion(env, `/pages/${shot.pageId}`, { method: 'PATCH', body: { properties: props } });

  // The Screenshots database is a reference only: the help docs themselves are never written to
  // (Active docs are live on Webflow through Whalesync). Swapping a doc's image stays a person's call.
  return { id, version, file: `${base}.${ext}`, row: shot.url };
}

// Notion's file links are signed S3 URLs without CORS headers; the Framer draws them on a canvas,
// so they come through here.
async function proxyFile(u, cors) {
  let target;
  try { target = new URL(u); } catch { return json({ error: 'Bad file URL' }, 400, cors); }
  const okHost = /(^|\.)amazonaws\.com$|(^|\.)notion\.so$|(^|\.)notion-static\.com$|(^|\.)notionusercontent\.com$/.test(target.hostname);
  if (target.protocol !== 'https:' || !okHost) return json({ error: 'Only Notion file links' }, 400, cors);
  const res = await fetch(target);
  return new Response(res.body, {
    status: res.status,
    headers: { ...cors, 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream', 'Cache-Control': 'private, max-age=300' },
  });
}

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || '',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-framer-passcode',
    Vary: 'Origin',
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
}

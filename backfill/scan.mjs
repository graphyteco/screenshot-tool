// Read-only scan of Docs (Publish): every image block per doc. Writes scan.json.
import fs from 'node:fs';
const T = process.env.RELUME_NOTION_PAT, V = '2025-09-03', N = 'https://api.notion.com/v1';
const DOCS_DS = '3345c3c8-064a-80d2-9307-000bc5b54eef';
async function n(path, opts = {}) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(N + path, { ...opts, headers: { Authorization: `Bearer ${T}`, 'Notion-Version': V, 'Content-Type': 'application/json' } });
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 1500 * (i + 1))); continue; }
    const d = await r.json(); if (!r.ok) throw new Error(path + ' ' + d.message); return d;
  }
  throw new Error('retries ' + path);
}
const txt = rt => (rt || []).map(t => t.plain_text).join('');
const docs = []; let cursor;
do { const d = await n(`/data_sources/${DOCS_DS}/query`, { method: 'POST', body: JSON.stringify({ page_size: 100, start_cursor: cursor }) }); docs.push(...d.results); cursor = d.has_more ? d.next_cursor : undefined; } while (cursor);
if (process.argv[2] === 'schema') { console.log(JSON.stringify(Object.fromEntries(Object.entries(docs[0].properties).map(([k, v]) => [k, v.type])), null, 1)); process.exit(); }
const out = [];
async function walk(id, ctx, imgs, depth = 0) {
  let c; do {
    const d = await n(`/blocks/${id}/children?page_size=100${c ? '&start_cursor=' + c : ''}`);
    for (const b of d.results) {
      if (/^heading_/.test(b.type)) ctx.heading = txt(b[b.type].rich_text);
      if (b.type === 'image') { const im = b.image; imgs.push({ blockId: b.id, kind: im.type, url: im.type === 'external' ? im.external.url : im.file?.url, caption: txt(im.caption), heading: ctx.heading || '', created: b.created_time }); }
      else if (b.has_children && depth < 3 && !['child_page', 'child_database'].includes(b.type)) await walk(b.id, ctx, imgs, depth + 1);
    }
    c = d.has_more ? d.next_cursor : undefined;
  } while (c);
}
let i = 0;
for (const p of docs) {
  const pr = p.properties; const imgs = [];
  await walk(p.id, {}, imgs);
  out.push({ id: p.id, url: p.url, title: txt(pr.Title?.title), status: pr['Webflow Status']?.select?.name || pr['Webflow Status']?.status?.name || '', key: txt(pr['Doc key']?.rich_text), slug: txt(pr.Slug?.rich_text), images: imgs });
  if (++i % 20 === 0) console.error(i, '/', docs.length);
}
fs.writeFileSync('scan.json', JSON.stringify(out, null, 1));
const total = out.reduce((a, d) => a + d.images.length, 0);
const byStatus = {}; for (const d of out) { byStatus[d.status] ??= { docs: 0, withImages: 0, images: 0 }; const s = byStatus[d.status]; s.docs++; if (d.images.length) s.withImages++; s.images += d.images.length; }
console.log('docs', out.length, 'images', total, JSON.stringify(byStatus), 'external', out.flatMap(d => d.images).filter(x => x.kind === 'external').length);

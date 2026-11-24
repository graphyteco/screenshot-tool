// Backfill: one Screenshots row per image already in a help doc. Reads docs, writes only to Screenshots.
// node import.mjs [--only KEY] [--dry]
import fs from 'node:fs';
const T = process.env.RELUME_NOTION_PAT, V = '2025-09-03', N = 'https://api.notion.com/v1';
const SHOTS_DS = '4205c3c8-064a-81a3-84db-000b9345a3aa';
const args = process.argv.slice(2), only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null, dry = args.includes('--dry');
const sleep = ms => new Promise(s => setTimeout(s, ms));
async function n(path, { method = 'GET', body, form } = {}) {
  for (let i = 0; i < 6; i++) {
    const headers = { Authorization: `Bearer ${T}`, 'Notion-Version': V }; if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(N + path, { method, headers, body: form || (body && JSON.stringify(body)) });
    if (r.status === 429 || r.status >= 500) { await sleep(1500 * (i + 1)); continue; }
    const d = await r.json(); if (!r.ok) throw new Error(`${method} ${path}: ${d.message}`); return d;
  }
  throw new Error('retries ' + path);
}
const keys = JSON.parse(fs.readFileSync('keys.json')); const keyOf = t => keys[t.trim()];
const docs = JSON.parse(fs.readFileSync('scan.json')).filter(d => d.images.length);
const missing = docs.filter(d => !keyOf(d.title)); if (missing.length) throw new Error('No key: ' + missing.map(d => d.title));
const vals = Object.values(keys); if (new Set(vals).size !== vals.length) throw new Error('duplicate keys');
// Existing rows, so a rerun skips what's there.
const existing = new Set(); let c;
do { const d = await n(`/data_sources/${SHOTS_DS}/query`, { method: 'POST', body: { page_size: 100, start_cursor: c } }); for (const p of d.results) existing.add(p.properties.ID.title.map(t => t.plain_text).join('')); c = d.has_more ? d.next_cursor : undefined; } while (c);
const today = new Date().toISOString().slice(0, 10), log = [];
for (const doc of docs) {
  const key = keyOf(doc.title); if (only && key !== only) continue;
  for (const [i, img] of doc.images.entries()) {
    const id = `${key}-${String((i + 1) * 10).padStart(3, '0')}`;
    const slot = img.caption ? img.caption : img.heading ? `Under “${img.heading}”` : `Image ${i + 1}`;
    const blockUrl = `${doc.url}#${img.blockId.replace(/-/g, '')}`;
    if (existing.has(id)) { log.push({ id, skipped: 'exists' }); continue; }
    if (dry) { log.push({ id, doc: doc.title, status: doc.status, slot }); continue; }
    const b = await n(`/blocks/${img.blockId}`); // fresh signed URL
    const src = b.image.type === 'external' ? b.image.external.url : b.image.file.url;
    const res = await fetch(src); if (!res.ok) throw new Error(`download ${id}: ${res.status}`);
    const type = (res.headers.get('content-type') || 'image/png').split(';')[0];
    const ext = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/png': 'png' }[type] || (new URL(src).pathname.match(/\.(\w+)$/)?.[1] ?? 'png');
    const name = `${id}_v1.${ext}`;
    const up = await n('/file_uploads', { method: 'POST', body: { mode: 'single_part', filename: name, content_type: type } });
    const form = new FormData(); form.append('file', new Blob([await res.arrayBuffer()], { type }), name);
    await n(`/file_uploads/${up.id}/send`, { method: 'POST', form });
    const page = await n('/pages', { method: 'POST', body: { parent: { data_source_id: SHOTS_DS }, properties: {
      ID: { title: [{ text: { content: id } }] },
      Doc: { relation: [{ id: doc.id }] },
      Slot: { rich_text: [{ text: { content: slot.slice(0, 2000) } }] },
      Version: { number: 1 },
      Captured: { date: { start: img.created.slice(0, 10) } },
      Status: { select: { name: 'Current' } },
      Image: { files: [{ type: 'file_upload', file_upload: { id: up.id }, name }] },
      'Doc block': { url: blockUrl },
      'Changelog entry': { rich_text: [{ text: { content: `Imported from the doc on ${today}. Not yet retaken in the Framer.` } }] },
    } } });
    log.push({ id, doc: doc.title, status: doc.status, row: page.url });
    console.error('✓', id, doc.status);
  }
}
fs.writeFileSync(dry ? 'import-dry.json' : `import-log-${Date.now()}.json`, JSON.stringify(log, null, 1));
console.log(log.length, 'entries', log.filter(l => l.row).length, 'created', log.filter(l => l.skipped).length, 'skipped');

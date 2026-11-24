import fs from 'node:fs';
const T = process.env.RELUME_NOTION_PAT, h = { Authorization: `Bearer ${T}`, 'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' };
const out = {}; let c;
do { const r = await fetch('https://api.notion.com/v1/data_sources/3345c3c8-064a-80d2-9307-000bc5b54eef/query', { method: 'POST', headers: h, body: JSON.stringify({ page_size: 100, start_cursor: c }) }); const d = await r.json(); for (const p of d.results) out[p.id] = p.last_edited_time; c = d.has_more ? d.next_cursor : undefined; } while (c);
const f = process.argv[2]; if (f === 'compare') { const b = JSON.parse(fs.readFileSync('edited-before.json')); const changed = Object.keys(b).filter(k => b[k] !== out[k]); console.log(Object.keys(out).length, 'docs,', changed.length, 'changed', changed); } else { fs.writeFileSync('edited-before.json', JSON.stringify(out)); console.log('saved', Object.keys(out).length); }

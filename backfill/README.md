# Screenshots backfill (2026-11-24)

Loaded every image already in the help docs (Docs (Publish)) into the Screenshots database as v1 rows.
The docs are only read, never written: `edited.mjs` snapshots every doc's last-edited time before and
compares after (63 docs, 0 changed).

- `scan.mjs`: reads every doc's image blocks, in order, with the heading above each.
- `keys.json`: the three-letter doc key for each doc title. IDs are KEY-010, KEY-020… in doc order.
- `import.mjs [--only KEY] [--dry]`: one row per image: ID, Doc, Slot (caption, else the heading above),
  Version 1, Captured (when the image was added to the doc), Image (re-uploaded as KEY-010_v1.ext),
  Doc block (link straight to that image in the doc). Skips IDs that already exist, so it's safe to rerun.

Result: 121 rows from 37 docs (106 in Active docs). Run with RELUME_NOTION_PAT set.

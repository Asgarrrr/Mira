# tsc filter preview — before / after

A concrete preview of what `tscFilter` (V0.4, Task 05) will do to the
three committed fixtures under
`src/filter/filters/tsc/__fixtures__/`. Token counts are real, captured
via Anthropic's `messages.count_tokens` against `claude-opus-4-7`.

The `after.md` files are **hand-rolled from the spec**
(00-decisions.md § 9b + 05-tsc-parser.md), not real renderer output —
`tscFilter` ships in Task 05. They are faithful previews, intended as
input to the Cluster C designer's calibration.

## Comparison

| size   | before | after | ratio | saved |
|--------|-------:|------:|------:|------:|
| small  |   129 |  174 | **1.34** |   −45 |
| medium |  1634 |  663 | **0.40** |  +971 |
| large  |  2154 |  338 | **0.15** | +1816 |

Median ratio: **0.40**. V0.4 ship-gate (00-decisions.md § 10) requires
median ≤ 0.30 and ≥ 800 tokens saved on B1.

- **B1 saved threshold ✓** — 971 ≥ 800.
- **Median ratio ✗** — 0.40 > 0.30 (but right at the § 9 ASSUMPTION
  revision trigger of 0.40 "with cascade dedup applied").

This preview integrates the **§ 9b grouped-`also:` spec change** that
landed in this branch's last doc commit. The earlier flat form
(`also: <path>:<line>:<col>, <path>:<line>:<col>, …`) gave median 0.51;
grouping brought it to 0.40 by collapsing path repetition. Note the
single biggest move comes on `large.txt`: 1117 → 338 tokens (−70%) by
emitting the path once for all 31 sibling locations.

## What the demo shows

### `small/` — filter overhead loses on tiny inputs

`before.txt` is 2 lines / 129 tokens. `after.md` is 6 lines / 174
tokens. The `# tsc — N errors …` header, two single-finding bullets
(no cluster), and the `_evidence: …_` footer add structural cost the
payload can't amortize.

**Spec adjustment to consider:** if `raw_tokens < 200`, fall back to
passthrough. Renders the filter conditional on having something to
compress.

### `medium/` — B1, the headline scenario

`before.txt` is the actual `bun tsc --noEmit --pretty=false` output
after applying `eval/scenarios/B1/base.patch` to repo HEAD. 12 errors
across 7 files, with 8 of them sharing the same normalized message
shape ("Type X is missing the following properties from type Y: path,
kind") — exactly what cascade-dedup is for.

`after.md` shows:
- 1 cluster bullet of 8 → 3 lines (template / exemplar / grouped
  `also:`). The `also:` line groups the 7 sibling locations by file:
  `tests/context-pack.test.ts at 32:3; tests/evidence-store.test.ts
  at 176:5, 211:4, 259:5, 316:5, 373:5; …`.
- 4 single-finding bullets (TS2339, TS2488, TS2769, TS7006) sorted by
  ruleId.
- The `TS2769` continuation truncated to 240 chars + `…` (per spec
  reading of "truncate to 240 chars per continuation").

The TS2769 truncation matters: the raw continuation contains the
verbose `{ id: string; runId: string; … }` object literal twice. With
no truncation, this single bullet would consume ~250 tokens.

### `large/` — pure cascade scenario

32 instantiations of a 3-property type with only 1 property each.
After cluster-dedup, all 32 fold into one bullet. With grouped-`also:`,
the path appears once and the 31 sibling locations are listed as
`<path> at 4:7, 5:7, 6:7, …, 34:7` — costing ~30 tokens for the path
instead of ~430 tokens for 31 path repetitions.

This is where the spec change pays off most: **−779 tokens** on this
fixture vs the pre-grouping form, because the locations line was
38% of the original bullet's cost.

## Spec items the Cluster C designer should resolve before coding

1. **Continuation truncation rule.** "240 chars per continuation" —
   is that total bytes for the joined block, or per-line within the
   block? Different readings produce different `medium.txt` ratios
   (~0.40 vs ~0.59).
2. **Tiny-input passthrough threshold.** Add an explicit floor (e.g.
   raw < 200 tokens → passthrough), or accept that small.txt's
   `after` will always be larger than its `before`.
3. **Per-cut recovery hint inside `also:`** (§ 9c bullet 1). Today's
   spec emits no cap on `also:` length. With grouping the cap matters
   far less, but for clusters > 50 in a single file the `also:` line
   could still bloat. Decision: do we cap (e.g. first 8 per group +
   `+M more`) or rely on grouping alone? Recommend **rely on grouping
   alone** in V0.4 — no real fixture exercises the > 50 case.

If (1) is resolved as total-bytes-240 and (2) is added, the projected
median lands at: small ≈ 0.5 (from passthrough's near-zero overhead
masked into median), medium 0.40, large 0.15 — median 0.40. To break
0.30 the renderer would need to also strip the verbose `{ path:
string; kind: ... }` repeated literal that bloats every type-mismatch
message; that's a V0.5+ refinement, not a V0.4 blocker.

## Reproducing the token counts

```bash
# From repo root, with eval/.env populated:
set -a; source eval/.env; set +a
for size in small medium large; do
  for f in demo/tsc-filter-preview/$size/{before.txt,after.md}; do
    content=$(cat "$f" | jq -Rs .)
    n=$(curl -sS https://api.anthropic.com/v1/messages/count_tokens \
      -H "x-api-key: $ANTHROPIC_API_KEY" \
      -H "anthropic-version: 2023-06-01" \
      -H "content-type: application/json" \
      -d "{\"model\":\"claude-opus-4-7\",\"messages\":[{\"role\":\"user\",\"content\":$content}]}" \
      | jq -r .input_tokens)
    echo "$f: $n tokens"
  done
done
```

`before.txt` files are byte-identical copies of the corresponding
fixtures under `src/filter/filters/tsc/__fixtures__/` at commit
`54ec764`. Re-copy when those change.

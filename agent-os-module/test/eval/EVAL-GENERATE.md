# Eval — the generation gate: does the format survive a content swap

Not text-for-text: a `generate` case authors a DIFFERENT script for the same film, on
purpose. What has to survive is the FORMAT — regions, board rows, caption placement,
layer order, the kinds of motion in each layer — measured from the film once (by
clone-film.mjs, to build the clone) and again from the clone's own render, then compared.

Run 2026-09-22 13:20

| case | board rows | pictures pinned | layer order | verdict |
|---|---|---|---|---|
| `ranking-football--swap-topic` | 5 → 5 | 8 → 8 | unchanged | clears the bar |
| `ranking-football--swap-effect` | 5 → 5 | 8 → 8 | unchanged | clears the bar |
| `podcast--swap-app` | 0 → 0 | 0 → 0 | **changed** | **below the bar** |
| `podcast--swap-host` | 0 → 0 | 0 → 0 | unchanged | clears the bar |
| `podcast--swap-item` | 0 → 0 | 0 → 0 | unchanged | clears the bar |
| `interview--swap-host` | 0 → 0 | 0 → 0 | **changed** | **below the bar** |
| `interview--swap-lang` | 0 → 0 | 0 → 0 | **changed** | **below the bar** |
| `interview--swap-ride` | 0 → 0 | 0 → 0 | **changed** | **below the bar** |

## What the columns mean

**Board rows** — how many labelled tier rows the format has, measured from the source and
again from the render. A count, not a percentage: losing one is losing a row.

**Pictures pinned** — the insert layer's item count, source vs render. Also exact: a
format either drops the same number of pictures over its board or it does not.

**Layer order** — the regions carrying content, sorted by z. Changed order means a layer
moved in front of or behind another one, independent of where its rectangle sits.
# Eval — our extraction against someone else's authored data

Text only, and deliberately so: it costs nothing, it runs on every change, and every
defect this pipeline has had would have shown up here before a single frame was drawn.
Pictures are placeholders throughout — a generated photograph cannot make a wrong
structure right.

Run 2026-09-22 12:53

| case | words heard | caption breaks | pictures pinned to speech | board |
|---|---|---|---|---|
| `interview--reference` | 90% (82/91) | 31/42 | 0 vs 0 authored | none, correctly |
| `interview--swap-host` | — | — | _a target for the generation gate, not a reference for extraction_ | — |
| `interview--swap-lang` | — | — | _a target for the generation gate, not a reference for extraction_ | — |
| `interview--swap-ride` | — | — | _a target for the generation gate, not a reference for extraction_ | — |
| `podcast--reference` | 97% (67/69) | 17/17 | 0 vs 0 authored | none, correctly |
| `podcast--swap-app` | — | — | _a target for the generation gate, not a reference for extraction_ | — |
| `podcast--swap-host` | — | — | _a target for the generation gate, not a reference for extraction_ | — |
| `podcast--swap-item` | — | — | _a target for the generation gate, not a reference for extraction_ | — |
| `ranking-football--reference-gpt` | 100% (67/67) | 21/22 | 8 vs 8 authored | 5 rows, measured |
| `ranking-football--reference` | 100% (67/67) | 21/22 | 8 vs 8 authored | 5 rows, measured |
| `ranking-football--swap-effect` | — | — | _a target for the generation gate, not a reference for extraction_ | — |
| `ranking-football--swap-host` | 100% (67/67) | 21/22 | 8 vs 8 authored | 5 rows, measured |
| `ranking-football--swap-topic` | — | — | _a target for the generation gate, not a reference for extraction_ | — |

## What the numbers mean

**Words heard** — the longest run of their script our aligner recovered, word for word.
Anything anchored to speech is only as good as this.

**Caption breaks** — how many of their cue breaks we cut within one word of. This is the
format's rhythm, and it is the thing a viewer feels without being able to name.

**Pictures pinned to speech** — how many timed pictures we found over the board against how
many they anchored to words. Counting the same number is the floor, not the ceiling: the
next check is whether they cover the same words.

**Board** — the check that costs nothing and catches the worst kind of mistake. Six of
these films have no ranking in them at all. A row reported in one of those was not
measured, it was recognised: the pipeline finding the shape of the film it was built on.
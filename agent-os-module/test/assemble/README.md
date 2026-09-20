# assemble probe

Offline checks for `/api/video/auto/assemble` — the route Agent OS owns and this
module patches. Nothing here writes to the Agent OS tree; project directories are
mkdtemp scratch.

    node --experimental-strip-types probe.mjs --source /path/to/agent-os/source

Checks that a malformed body answers 400 naming the field (null scene, numeric
`narration_line`, ranking `items` holding a null, lists longer than the card fits),
that a caller who asked for narration never gets a silent film reported as a
success (502 on a failed download, and on a file with no audio stream), that
caller text comes out escaped, and that the smoke shape — five b-roll clips,
local-route narration, ranking/stat/compare graphics — still renders.

`--repro` adds the installer round-trip: `git show HEAD:<route>` in the source
tree, one run of `../register-nav.py` over it, then a byte comparison against the
live route and a `tsc` pass over the regenerated file.

Flags (env fallback in brackets): `--source` [`AGENT_OS_SOURCE`], `--route`,
`--installer` (default `../register-nav.py`), `--tsc` (default
`<source>/node_modules/.bin/tsc`), `--scratch`, `--repro`.

`ffprobe` is faked through `PATH` for the audio-stream cases, so the probe needs no
media files and no network.

#!/usr/bin/env python3
"""Upgrade the Video Director's OmniWatch bridge UI to v2.

    python3 patch-director-ui-v2.py <agent-os>/source

`patch-director.py` installs the v1 bridge: the `?brief=` reader, the pacing banner
and the scene hand-off. v2 is the same bridge with a different UI on top of it — the
whole component, not an insertion — so it cannot be another anchored replacement and
it cannot be applied on top of itself.

That is why this one is guarded by a hash instead of an anchor, and why it refuses to
guess. Three states are possible:

  * the file already matches the payload → nothing to do, says so, writes nothing
  * the file is exactly v1               → replaced with the v2 file from patches/
  * anything else                        → prints what it found and stops, writes nothing

The third case is the point. An Agent OS update, or a hand edit, can leave a
VideoDirector that is neither v1 nor v2; overwriting that silently would throw away
whatever is in it. Failing loudly leaves the decision with a person, and the message
says which hash was found so it can be compared against the two below.

The postimage is read from patches/VideoDirector.bridge-ui.tsx and hashed at run time,
deliberately: that file is the one being fixed as the UI is fixed, and a version of
this script carrying a frozen hash would quietly re-install an older card than the one
in the module. Only the v1 preimage is a constant, because v1 is finished.
"""
import hashlib
import os
import shutil
import sys

src = sys.argv[1] if len(sys.argv) > 1 else "."
here = os.path.dirname(os.path.abspath(__file__))
target = f"{src}/src/components/VideoDirector.tsx"
payload = f"{here}/patches/VideoDirector.bridge-ui.tsx"

# sha256 of the one file this script is willing to replace: `git show
# HEAD:src/components/VideoDirector.tsx` in the Agent OS checkout after
# patch-director.py has run (the v1 bridge patch is committed there). Fixed on purpose —
# v1 is not going to change. The postimage is not a constant; see the module docstring.
V1_SHA256 = "d55b3abee64abe6be4529203586448df2d16268a36d7e6dea107aea25ecabf84"


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    if not os.path.exists(target):
        return "skipped — Agent OS has no VideoDirector.tsx here"

    if not os.path.exists(payload):
        print(f"  ✗ patches/VideoDirector.bridge-ui.tsx is missing — nothing was written.")
        sys.exit(1)
    postimage = sha256(payload)

    current = sha256(target)
    if current == postimage:
        return "already v2"

    if current != V1_SHA256:
        print(f"  ✗ VideoDirector.tsx is neither v1 nor v2 — nothing was written.")
        print(f"      found:    {current}")
        print(f"      expected: {V1_SHA256}  (v1, what patch-director.py installs)")
        print(f"                {postimage}  (v2, the module's patches/VideoDirector.bridge-ui.tsx)")
        print(f"      An Agent OS update or a local edit changed this file. Reconcile it")
        print(f"      by hand, then re-run, or restore v1 and re-run the installer.")
        sys.exit(1)

    shutil.copyfile(payload, target)
    return "v1 → v2 UI applied"


if __name__ == "__main__":
    print(f"  · Director UI v2: {main()}")

#!/usr/bin/env python3
"""A fresh Agent OS install, patched twice.

    python3 agent-os-module/test/fresh-install.py

This is the test the first version of patch-director.py needed and did not have: the
graphics patch called a helper that did not exist (`sub1`), which is a NameError on a
fresh route — and invisible on an already-patched one, because the sentinel returned
early before the call. So the test starts from the pristine files in git and runs the
installer the way install.sh does, then runs it again to prove it is a no-op.

Exit code is 0 only if every check holds.
"""
import pathlib
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
MODULE = HERE.parent
AGENT_OS = pathlib.Path.home() / "Documents" / "agent-os" / "source"
if len(sys.argv) > 1:
    AGENT_OS = pathlib.Path(sys.argv[1])

ROUTE = "src/app/api/video/auto/script/route.ts"
DIRECTOR = "src/components/VideoDirector.tsx"
checks = []


def check(name, ok, detail=""):
    checks.append((name, ok, detail))
    print(f"  {'ok  ' if ok else 'FAIL'} {name}{' — ' + detail if detail and not ok else ''}")


def pristine(rel, dest):
    out = subprocess.run(["git", "-C", str(AGENT_OS), "show", f"HEAD:{rel}"],
                         capture_output=True, text=True)
    if out.returncode != 0:
        check(f"git show HEAD:{rel}", False, out.stderr.strip()[:200])
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(out.stdout, encoding="utf-8")
    return True


with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    if not (pristine(ROUTE, root / ROUTE) and pristine(DIRECTOR, root / DIRECTOR)):
        sys.exit(1)
    route = root / ROUTE
    director = root / DIRECTOR

    first = subprocess.run([sys.executable, str(MODULE / "patch-director.py"), str(root)],
                           capture_output=True, text=True)
    check("installer exits clean on a fresh tree", first.returncode == 0, first.stderr.strip()[-300:])
    check("no patch reported 'could not patch'", "could not patch" not in first.stdout, first.stdout)
    patched = route.read_text(encoding="utf-8")
    check("scene cap widened to 60", "slice(0, 60)" in patched)
    check("graphics patch applied", "omni-graphic-v2" in patched)
    check("pending-brief guard applied", "omni-author-pending" in patched)
    check("guard is a 503 with a reason",
          'pending: "omniwatch-script-author"' in patched and "status: 503" in patched)
    check("VideoDirector bridge applied", "omni-brief" in director.read_text(encoding="utf-8"))

    before = {p: p.read_text(encoding="utf-8") for p in (route, director)}
    second = subprocess.run([sys.executable, str(MODULE / "patch-director.py"), str(root)],
                            capture_output=True, text=True)
    after = {p: p.read_text(encoding="utf-8") for p in (route, director)}
    check("second run exits clean", second.returncode == 0, second.stderr.strip()[-300:])
    check("second run changes nothing", before == after)
    check("second run says already patched", second.stdout.count("already patched") >= 3, second.stdout)

failed = [n for n, ok, _ in checks if not ok]
print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
sys.exit(1 if failed else 0)

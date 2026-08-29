"""Run the shared Fountain fixture corpus against fountain.py.

Usage: python -m tests.fountain.test_python  (from Faaglarna/)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
import fountain  # noqa: E402


def normalize(tok: dict) -> dict:
    out = {}
    for k, v in tok.items():
        if v is None:
            continue
        if isinstance(v, list) and not v:
            continue
        out[k] = v
    return out


def run() -> int:
    fixtures = ROOT / "tests" / "fountain" / "basic.json"
    cases = json.loads(fixtures.read_text(encoding="utf-8"))
    passed = failed = 0
    for c in cases:
        result = fountain.parse(c["input"])
        actual = [normalize(t) for t in result["tokens"]]
        expected = c["expected"]
        ok = len(actual) == len(expected)
        if ok:
            for a, e in zip(actual, expected):
                for k, v in e.items():
                    if a.get(k) != v:
                        ok = False; break
                if not ok:
                    break
        if "expectedTitle" in c:
            for k, v in c["expectedTitle"].items():
                if result["titlePage"].get(k) != v:
                    ok = False
        if ok:
            passed += 1
            print(f"  PASS {c['name']}")
        else:
            failed += 1
            print(f"  FAIL {c['name']}")
            print(f"    expected: {expected}")
            print(f"    actual:   {actual}")
    print(f"{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


# Cue text -> the character it identifies. A character cue prints as the writer
# typed it, but everything that asks WHICH character this is must fold the
# modifiers away, or the same person gets two colours, two voices and two rows
# in the character list.
CUE_CASES = [
    ("SARA", "SARA"),
    ("SARA (CONT'D)", "SARA"),
    ("SARA (V.O.)", "SARA"),
    ("SARA (O.S.)", "SARA"),
    ("SARA (V.O.) (CONT'D)", "SARA"),      # chained modifiers fold too
    ("SARA   ", "SARA"),
    ("Sara", "SARA"),                      # a forced @Sara cue is the same person
    ("O'BRIEN (CONT'D)", "O'BRIEN"),
    ("ÅSE (O.S.)", "ÅSE"),                 # non-ASCII survives the fold
    ("MRS. (LILY) SMITH", "MRS. (LILY) SMITH"),  # only TRAILING modifiers go
    ("", ""),
]


def run_character_key() -> int:
    """character_key, and its agreement with the JavaScript port.

    pagination.py and static/pagination.js are two implementations of the same
    rules, and the PDF export renders through this one while the screen renders
    through that one. A divergence here shows up as a page break that breaks in
    a different place on paper than on screen, so the parity is worth asserting
    rather than assuming.
    """
    import pagination  # noqa: PLC0415

    passed = failed = 0
    for cue, want in CUE_CASES:
        got = pagination.character_key(cue)
        if got == want:
            passed += 1
            print(f"  PASS character_key({cue!r})")
        else:
            failed += 1
            print(f"  FAIL character_key({cue!r}) -> {got!r}, expected {want!r}")

    # The same inputs through the JavaScript port, which must agree exactly.
    import json as _json
    import shutil
    import subprocess

    node = shutil.which("node")
    if not node:
        print("  SKIP javascript parity (node not on PATH)")
    else:
        script = (
            "const P=require(process.argv[1]);"
            "const cues=JSON.parse(process.argv[2]);"
            "console.log(JSON.stringify(cues.map(c=>P.characterKey(c))));"
        )
        cues = [c for c, _ in CUE_CASES]
        out = subprocess.run(
            [node, "-e", script, str(ROOT / "static" / "pagination.js"), _json.dumps(cues)],
            capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
        if out.returncode != 0:
            failed += 1
            print(f"  FAIL javascript port did not run: {out.stderr.strip()[:200]}")
        else:
            js = _json.loads(out.stdout)
            py = [pagination.character_key(c) for c in cues]
            if js == py:
                passed += 1
                print(f"  PASS javascript port agrees on all {len(cues)} cues")
            else:
                failed += 1
                for c, a, b in zip(cues, py, js):
                    if a != b:
                        print(f"  FAIL {c!r}: python {a!r} vs javascript {b!r}")

    print(f"{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


# A script carrying both kinds of heading: one forced with a dot, one an
# ordinary screenplay slug line.
SCENE_SRC = "\n".join([
    "Title: Prove", "Format: FORMAT", "",
    ".The kitchen, later", "",
    "SARA", "Hallo?", "",
    "INT. KITCHEN - DAY", "",
    "More action.", "",
])

# Screenplay keeps both. Stage and radio organise by `#` sections, so they drop
# slug lines — but a heading the writer forced with a dot is an explicit
# instruction and survives in every format.
SCENE_EXPECTED = {
    "screenplay": ["THE KITCHEN, LATER", "INT. KITCHEN - DAY"],
    "stage": ["THE KITCHEN, LATER"],
    "radio": ["THE KITCHEN, LATER"],
}


def _scene_headings_py(fmt: str) -> list[str]:
    import fountain as _f  # noqa: PLC0415
    import pagination as _p  # noqa: PLC0415

    out = _p.paginate_script(_f.parse(SCENE_SRC.replace("FORMAT", fmt)))
    return [b.lines[0] for page in out["pages"] for b in page["blocks"]
            if b.kind == "scene"]


def run_scene_headings() -> int:
    """Which scene headings survive in each format, and JS/Python agreement.

    The heading is DROPPED in the paginator rather than hidden in CSS, so that
    the screen, the PDF and the page-break logic cannot disagree — which they
    previously did, in all three directions at once.
    """
    passed = failed = 0
    for fmt, want in SCENE_EXPECTED.items():
        got = _scene_headings_py(fmt)
        if got == want:
            passed += 1
            print(f"  PASS {fmt} keeps {got}")
        else:
            failed += 1
            print(f"  FAIL {fmt} kept {got}, expected {want}")

    import json as _json
    import shutil
    import subprocess

    node = shutil.which("node")
    if not node:
        print("  SKIP javascript parity (node not on PATH)")
        print(f"{passed} passed, {failed} failed")
        return 0 if failed == 0 else 1

    script = (
        "const F=require(process.argv[1]),P=require(process.argv[2]);"
        "const src=process.argv[3],fmts=JSON.parse(process.argv[4]);const out={};"
        "for(const f of fmts){const o=P.paginateScript(F.parse(src.replace('FORMAT',f)));"
        "out[f]=o.pages.flatMap(p=>p.blocks).filter(b=>b.kind==='scene').map(b=>b.lines[0]);}"
        "console.log(JSON.stringify(out));"
    )
    res = subprocess.run(
        [node, "-e", script,
         str(ROOT / "static" / "fountain.js"), str(ROOT / "static" / "pagination.js"),
         SCENE_SRC, _json.dumps(list(SCENE_EXPECTED))],
        capture_output=True, text=True, encoding="utf-8", cwd=str(ROOT))
    if res.returncode != 0:
        failed += 1
        print(f"  FAIL javascript port did not run: {res.stderr.strip()[:200]}")
    else:
        js = _json.loads(res.stdout)
        py = {f: _scene_headings_py(f) for f in SCENE_EXPECTED}
        if js == py:
            passed += 1
            print(f"  PASS javascript port agrees for {', '.join(SCENE_EXPECTED)}")
        else:
            failed += 1
            print(f"  FAIL python {py} vs javascript {js}")

    print(f"{passed} passed, {failed} failed")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    rc = run()
    print()
    print("character identity")
    rc = run_character_key() or rc
    print()
    print("scene headings per format")
    rc = run_scene_headings() or rc
    sys.exit(rc)

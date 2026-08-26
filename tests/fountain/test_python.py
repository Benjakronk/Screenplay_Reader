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


if __name__ == "__main__":
    sys.exit(run())

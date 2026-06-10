"""Fountain parser — Python port of static/fountain.js.

Public API: parse(text) -> { "titlePage": dict, "tokens": list[dict] }

Token types: scene, action, character, parenthetical, dialogue,
dual-dialogue-begin, dual-dialogue-end, transition, section, synopsis,
note, page-break, lyric, centered.

Kept in lockstep with fountain.js via the shared corpus at
tests/fountain/basic.json — run `python -m tests.fountain.test_python` to
verify.
"""
from __future__ import annotations

import re

SCENE_PREFIX = re.compile(r"^(INT|EXT|EST|INT\.\/EXT|INT\/EXT|I\/E)[\.\s]", re.IGNORECASE)
TRANSITION_RE = re.compile(r"^[^a-z]+TO:\s*$")
FORCED_TRANSITION_RE = re.compile(r"^>\s*(.+?)\s*$")
CENTERED_RE = re.compile(r"^>\s*(.+?)\s*<\s*$")
SECTION_RE = re.compile(r"^(#{1,6})\s*(.+?)\s*$")
SYNOPSIS_RE = re.compile(r"^=\s+(.+?)\s*$")
PAGE_BREAK_RE = re.compile(r"^={3,}\s*$")
LYRIC_RE = re.compile(r"^~\s?(.*)$")
NOTE_INLINE_RE = re.compile(r"\[\[([^\]]*?)\]\]")
PARENTHETICAL_RE = re.compile(r"^\(.*\)$")
FORCED_CHARACTER_RE = re.compile(r"^@(.+?)(\s*\^)?\s*$")
FORCED_ACTION_RE = re.compile(r"^!(.*)$")
FORCED_SCENE_RE = re.compile(r"^\.(?!\.)(.+?)\s*$")
CHARACTER_RE = re.compile(r"^[A-Z0-9 .'\-]*[A-Z][A-Z0-9 .'\-]*(\s*\([^)]*\))?(\s*\^)?\s*$")
TITLE_KEY_RE = re.compile(r"^[A-Za-z][A-Za-z0-9 _\-]*:")
TITLE_KV_RE = re.compile(r"^([A-Za-z][A-Za-z0-9 _\-]*):\s*(.*)$")
BONEYARD_RE = re.compile(r"/\*[\s\S]*?\*/")


def _has_lower(s: str) -> bool:
    return bool(re.search(r"[a-z]", s))


def _strip_boneyard(text: str) -> str:
    return BONEYARD_RE.sub("", text)


def _split_title_page(lines: list[str]) -> tuple[dict, int]:
    i = 0
    while i < len(lines) and lines[i].strip() == "":
        i += 1
    if i >= len(lines):
        return {}, 0
    if not TITLE_KEY_RE.match(lines[i]):
        return {}, 0

    tp: dict = {}
    current_key: str | None = None
    end = i
    while end < len(lines):
        line = lines[end]
        if line.strip() == "":
            break
        m = TITLE_KV_RE.match(line)
        if m:
            current_key = m.group(1).lower().replace(" ", "_")
            tp[current_key] = m.group(2)
        elif current_key and re.match(r"^\s+", line):
            cont = re.sub(r"^\s+", "", line)
            tp[current_key] = (tp[current_key] + "\n" + cont) if tp[current_key] else cont
        else:
            break
        end += 1
    for k in list(tp):
        tp[k] = re.sub(r"\s+$", "", tp[k])
    while end < len(lines) and lines[end].strip() == "":
        end += 1
    return tp, end


def _extract_notes(text: str) -> tuple[str, list[str]]:
    notes: list[str] = []
    def repl(m):
        notes.append(m.group(1).strip())
        return ""
    clean = NOTE_INLINE_RE.sub(repl, text)
    return re.sub(r"\s+$", "", clean), notes


def _is_blank(line: str | None) -> bool:
    return line is None or line.strip() == ""


def _open_dual_before(tokens: list[dict]) -> None:
    for i in range(len(tokens) - 1, -1, -1):
        if tokens[i]["type"] == "character":
            tokens.insert(i, {"type": "dual-dialogue-begin"})
            return
    tokens.append({"type": "dual-dialogue-begin"})


def _classify(lines: list[str], body_start: int) -> list[dict]:
    tokens: list[dict] = []
    dual_open = False
    last_character_idx = -1
    blank_since_last_token = True

    def push(tok: dict) -> int:
        nonlocal blank_since_last_token
        tok["_blank_before"] = blank_since_last_token
        blank_since_last_token = False
        tokens.append(tok)
        return len(tokens) - 1

    def close_dual():
        nonlocal dual_open
        if dual_open:
            push({"type": "dual-dialogue-end"})
            dual_open = False

    i = body_start
    while i < len(lines):
        raw = lines[i]
        line = re.sub(r"\s+$", "", raw)
        prev = lines[i - 1] if i > 0 else ""
        nxt = lines[i + 1] if i + 1 < len(lines) else ""

        if line == "":
            blank_since_last_token = True
            i += 1
            continue

        if PAGE_BREAK_RE.match(line):
            close_dual(); push({"type": "page-break"}); i += 1; continue

        m = SECTION_RE.match(line)
        if m:
            close_dual()
            push({"type": "section", "level": len(m.group(1)), "text": m.group(2)})
            i += 1; continue

        m = SYNOPSIS_RE.match(line)
        if m and not PAGE_BREAK_RE.match(line):
            push({"type": "synopsis", "text": m.group(1)}); i += 1; continue

        m = CENTERED_RE.match(line)
        if m:
            close_dual(); push({"type": "centered", "text": m.group(1)}); i += 1; continue

        m = FORCED_TRANSITION_RE.match(line)
        if m and not line.endswith("<"):
            close_dual(); push({"type": "transition", "text": m.group(1)}); i += 1; continue

        m = FORCED_SCENE_RE.match(line)
        if m:
            close_dual(); push({"type": "scene", "text": m.group(1)}); i += 1; continue

        if SCENE_PREFIX.match(line) and _is_blank(prev) and _is_blank(nxt):
            close_dual(); push({"type": "scene", "text": line}); i += 1; continue

        if TRANSITION_RE.match(line) and not _has_lower(line) and _is_blank(prev) and _is_blank(nxt):
            close_dual(); push({"type": "transition", "text": line}); i += 1; continue

        m = LYRIC_RE.match(line)
        if m:
            push({"type": "lyric", "text": m.group(1)}); i += 1; continue

        m = FORCED_ACTION_RE.match(line)
        if m:
            close_dual()
            clean, notes = _extract_notes(m.group(1))
            push({"type": "action", "text": clean, "notes": notes})
            i += 1; continue

        m = FORCED_CHARACTER_RE.match(line)
        if m and _is_blank(prev) and not _is_blank(nxt):
            name = m.group(1).strip()
            dual = bool(m.group(2))
            if dual:
                _open_dual_before(tokens); dual_open = True
            else:
                close_dual()
            last_character_idx = push({"type": "character", "text": name, "dual": dual})
            i += 1; continue

        if (CHARACTER_RE.match(line) and not _has_lower(line)
                and _is_blank(prev) and not _is_blank(nxt)):
            name = line
            dual = False
            if re.search(r"\^\s*$", name):
                dual = True
                name = re.sub(r"\^\s*$", "", name).strip()
            if dual:
                _open_dual_before(tokens); dual_open = True
            else:
                close_dual()
            last_character_idx = push({"type": "character", "text": name, "dual": dual})
            i += 1; continue

        if last_character_idx >= 0 and tokens:
            last = tokens[-1]
            last_is_cue = last["type"] in ("character", "parenthetical", "dialogue")
            if last_is_cue and not _is_blank(prev):
                if PARENTHETICAL_RE.match(line):
                    push({"type": "parenthetical", "text": line}); i += 1; continue
                clean, notes = _extract_notes(line)
                push({"type": "dialogue", "text": clean, "notes": notes}); i += 1; continue

        close_dual()
        clean, notes = _extract_notes(line)
        push({"type": "action", "text": clean, "notes": notes})
        i += 1

    close_dual()

    # Merge adjacent action tokens not separated by blank lines.
    out: list[dict] = []
    for tok in tokens:
        if (tok["type"] == "action" and out and out[-1]["type"] == "action"
                and not tok.get("_blank_before")):
            out[-1]["text"] = out[-1]["text"] + "\n" + tok["text"]
            if tok.get("notes"):
                out[-1]["notes"] = (out[-1].get("notes") or []) + tok["notes"]
        else:
            out.append(tok)
    for t in out:
        t.pop("_blank_before", None)
    return out


def parse(text: str) -> dict:
    if not isinstance(text, str):
        text = str(text or "")
    normalized = _strip_boneyard(text.replace("\r\n", "\n").replace("\r", "\n"))
    lines = normalized.split("\n")
    tp, body_start = _split_title_page(lines)
    tokens = _classify(lines, body_start)
    return {"titlePage": tp, "tokens": tokens}


# Inline emphasis → plain runs. Returns a list of (text, style_set) pairs
# where style_set is a subset of {"bold", "italic", "underline"}.
INLINE_TOKEN_RE = re.compile(r"(\*\*\*|\*\*|\*|_)")


def inline_runs(text: str) -> list[tuple[str, frozenset]]:
    # Greedy match: longest delimiters first. We tokenize, then walk.
    parts = INLINE_TOKEN_RE.split(text)
    out: list[tuple[str, frozenset]] = []
    bold = False; italic = False; underline = False
    i = 0
    while i < len(parts):
        chunk = parts[i]
        if chunk == "***":
            bold = not bold; italic = not italic
        elif chunk == "**":
            bold = not bold
        elif chunk == "*":
            italic = not italic
        elif chunk == "_":
            underline = not underline
        else:
            if chunk:
                style = set()
                if bold: style.add("bold")
                if italic: style.add("italic")
                if underline: style.add("underline")
                out.append((chunk, frozenset(style)))
        i += 1
    return out


if __name__ == "__main__":
    import json, sys
    if len(sys.argv) < 2:
        print("usage: fountain.py file.fountain", file=sys.stderr); sys.exit(2)
    with open(sys.argv[1], encoding="utf-8") as f:
        print(json.dumps(parse(f.read()), indent=2, ensure_ascii=False))

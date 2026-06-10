"""Shared screenplay/stage/radio pagination — Python port of pagination.js.

Public API:
    paginate_script(parsed) -> dict
       {"rules": FormatRules,
        "titlePage": dict,
        "pages": [ Page ]}

Kept in lockstep with static/pagination.js. PDF and HTML render from the
same `Page` list so they paginate identically.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class FormatRules:
    name: str
    pageW: float = 8.5
    pageH: float = 11.0
    left: float = 1.5
    right: float = 1.0
    top: float = 1.0
    bottom: float = 1.0
    characterIndent: float = 3.7
    parenIndent: float = 3.1
    dialogueIndent: float = 2.5
    dialogueWidth: float = 3.3
    actionWidth: float = 6.0
    transitionAlign: str = "right"
    paginate: str = "lines"


SCREENPLAY = FormatRules(name="screenplay")
STAGE = FormatRules(
    name="stage",
    left=1.25, right=1.25,
    characterIndent=1.25, parenIndent=1.6, dialogueIndent=1.6,
    dialogueWidth=4.6,
    transitionAlign="left",
    paginate="scene",
)
RADIO = FormatRules(
    name="radio",
    left=1.25, right=1.0,
    characterIndent=1.25, parenIndent=1.6, dialogueIndent=2.5,
    dialogueWidth=4.0,
    transitionAlign="left",
    paginate="scene",
)
RULES = {"screenplay": SCREENPLAY, "stage": STAGE, "radio": RADIO}

CHARS_PER_INCH = 10
LINES_PER_INCH = 6


def rules_for_title_page(tp: dict) -> FormatRules:
    name = str((tp or {}).get("format", "screenplay")).lower().strip()
    return RULES.get(name, SCREENPLAY)


def width_chars(width_in: float) -> int:
    return max(1, int(width_in * CHARS_PER_INCH))


# ---------- text wrapping ----------

def wrap_lines(text: str, wc: int) -> list[str]:
    out: list[str] = []
    for para in str(text or "").split("\n"):
        if not para:
            out.append("")
            continue
        words = para.split(" ")
        line = ""
        for w in words:
            candidate = (line + " " + w) if line else w
            if len(candidate) <= wc:
                line = candidate
            else:
                if line:
                    out.append(line)
                while len(w) > wc:
                    out.append(w[:wc]); w = w[wc:]
                line = w
        if line:
            out.append(line)
    return out


# ---------- token → blocks ----------

@dataclass
class Block:
    kind: str
    lines: list[str] = field(default_factory=list)
    indentIn: float = 0.0
    align: str = "left"
    bold: bool = False
    italic: bool = False
    underline: bool = False
    cue: str | None = None
    splittable: bool = True
    left: list[Any] | None = None
    right: list[Any] | None = None
    tokIdx: int | None = None


def tokens_to_blocks(tokens: list[dict], rules: FormatRules) -> list[Block]:
    blocks: list[Block] = []
    dual_buf: dict | None = None
    last_character: str | None = None

    def make_block(tok: dict, character_for_dialogue: str | None) -> Block:
        t = tok.get("type")
        text = tok.get("text", "") or ""
        if t == "scene":
            return Block(kind="scene",
                         lines=wrap_lines(text.upper(), width_chars(rules.actionWidth)),
                         indentIn=0, bold=True)
        if t == "action":
            return Block(kind="action",
                         lines=wrap_lines(text, width_chars(rules.actionWidth)),
                         indentIn=0)
        if t == "character":
            name = text.replace("\n", " ").strip()
            return Block(kind="character", lines=[name.upper()],
                         indentIn=rules.characterIndent - rules.left,
                         cue=name.upper(), splittable=False)
        if t == "parenthetical":
            return Block(kind="parenthetical",
                         lines=wrap_lines(text, width_chars(rules.dialogueWidth + 0.5)),
                         indentIn=rules.parenIndent - rules.left,
                         splittable=False)
        if t == "dialogue":
            return Block(kind="dialogue",
                         lines=wrap_lines(text, width_chars(rules.dialogueWidth)),
                         indentIn=rules.dialogueIndent - rules.left,
                         cue=character_for_dialogue, splittable=True)
        if t == "transition":
            return Block(kind="transition", lines=[text.upper()],
                         indentIn=0, align=rules.transitionAlign)
        if t == "section":
            level = tok.get("level", 1) or 1
            b = Block(kind="section",
                      lines=wrap_lines(text.upper(), width_chars(rules.actionWidth)),
                      indentIn=0, bold=True)
            b.level = level
            return b
        if t == "synopsis":
            return Block(kind="synopsis",
                         lines=wrap_lines(text, width_chars(rules.actionWidth)),
                         indentIn=0, italic=True)
        if t == "centered":
            return Block(kind="centered", lines=[text], indentIn=0, align="center")
        if t == "lyric":
            return Block(kind="lyric",
                         lines=wrap_lines(text, width_chars(rules.actionWidth)),
                         indentIn=0, italic=True)
        if t == "page-break":
            return Block(kind="page-break", lines=[], splittable=False)
        return Block(kind="action",
                     lines=wrap_lines(text, width_chars(rules.actionWidth)),
                     indentIn=0)

    for idx, tok in enumerate(tokens):
        t = tok.get("type")
        if t == "dual-dialogue-begin":
            dual_buf = {"left": [], "right": [], "side": "left"}
            continue
        if t == "dual-dialogue-end":
            if dual_buf:
                blocks.append(Block(kind="dual", lines=[], indentIn=0,
                                    left=dual_buf["left"], right=dual_buf["right"],
                                    splittable=False, tokIdx=idx))
            dual_buf = None
            continue
        if t == "character":
            last_character = (tok.get("text") or "").upper()
            if dual_buf and tok.get("dual"):
                dual_buf["side"] = "right"
        b = make_block(tok, last_character)
        b.tokIdx = idx
        if dual_buf:
            dual_buf[dual_buf["side"]].append(b)
        else:
            blocks.append(b)
    return blocks


# ---------- pagination ----------

def block_line_count(b: Block) -> int:
    if b.kind == "page-break":
        return 0
    if b.kind == "dual":
        l = sum(max(1, len(x.lines)) + 1 for x in (b.left or []))
        r = sum(max(1, len(x.lines)) + 1 for x in (b.right or []))
        return max(l, r)
    return max(1, len(b.lines))


def space_before(b: Block, first_on_page: bool) -> int:
    if first_on_page:
        return 0
    if b.kind in ("scene", "section", "character", "transition"):
        return 1
    return 0


def space_after(b: Block) -> int:
    if b.kind in ("character", "parenthetical", "dialogue"):
        return 0
    return 1


def lines_per_page(rules: FormatRules) -> int:
    return int((rules.pageH - rules.top - rules.bottom) * LINES_PER_INCH)


def paginate(blocks: list[Block], rules: FormatRules) -> list[list[Block]]:
    cap = lines_per_page(rules)
    pages: list[list[Block]] = []
    current: list[Block] = []
    used = 0

    def flush():
        nonlocal current, used
        if current:
            pages.append(current)
            current = []
            used = 0

    def fits(n): return used + n <= cap

    i = 0
    while i < len(blocks):
        b = blocks[i]

        if b.kind == "page-break":
            flush(); i += 1; continue

        if rules.paginate == "scene" and b.kind == "scene" and current:
            flush()

        first = not current
        sb = space_before(b, first)
        lines = block_line_count(b)

        glue = 0
        if b.kind == "character" and i + 1 < len(blocks):
            nxt = blocks[i + 1]
            if nxt.kind in ("parenthetical", "dialogue"):
                glue = block_line_count(nxt)
        needed = sb + lines + glue

        if not fits(needed) and not first:
            if b.kind == "dialogue" and b.splittable:
                room = cap - used - sb - 1
                if room >= 2:
                    head = Block(kind="dialogue", lines=b.lines[:room],
                                 indentIn=b.indentIn, cue=b.cue, tokIdx=b.tokIdx)
                    tail = Block(kind="dialogue", lines=b.lines[room:],
                                 indentIn=b.indentIn, cue=b.cue, tokIdx=b.tokIdx)
                    current.append(head)
                    current.append(Block(kind="more", lines=["(MORE)"],
                                         indentIn=rules.characterIndent - rules.left,
                                         splittable=False))
                    used += len(head.lines) + 1
                    flush()
                    if b.cue:
                        current.append(Block(kind="contd", lines=[b.cue + " (CONT'D)"],
                                             indentIn=rules.characterIndent - rules.left,
                                             cue=b.cue, splittable=False))
                        used += 1
                    current.append(tail)
                    used += len(tail.lines) + space_after(tail)
                    i += 1; continue
            flush()
            sb = space_before(b, True)
            used = sb
        else:
            used += sb

        current.append(b)
        used += lines + space_after(b)
        i += 1
    flush()
    return pages


def paginate_script(parsed: dict) -> dict:
    tp = parsed.get("titlePage") or {}
    rules = rules_for_title_page(tp)
    blocks = tokens_to_blocks(parsed.get("tokens") or [], rules)
    body_pages = paginate(blocks, rules)
    pages = [{"blocks": pb, "pageNumber": i + 1, "isTitlePage": False}
             for i, pb in enumerate(body_pages)]
    if tp:
        pages.insert(0, {"blocks": [], "pageNumber": 0, "isTitlePage": True, "titlePage": tp})
    return {"rules": rules, "titlePage": tp, "pages": pages}

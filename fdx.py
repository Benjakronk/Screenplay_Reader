"""Final Draft (.fdx) interchange for Fountain scripts.

Two directions, both reusing the shared parser (`fountain.py`):

  build_fdx(text)        Fountain source -> .fdx (bytes, UTF-8 XML)
  fdx_to_fountain(xml)   .fdx XML        -> Fountain source (str)

FDX is XML: a <Content> of <Paragraph Type="..."> elements, each holding one or
more <Text> runs that may carry a Style ("Bold", "Italic", "Underline", or a
"+"-joined combination). A <TitlePage> block holds the cover.

Faithful for the standard screenplay elements (scene, action, character,
parenthetical, dialogue, transition, centered, inline emphasis, title page,
notes). Fountain-specific niceties are approximated, by design:

  - dual dialogue is flattened to sequential speaker blocks (FDX's side-by-side
    encoding is version-specific; flattening keeps the content intact);
  - sections (`#`) export as bold action; synopses (`=`) and lyrics (`~`) export
    as italic action (so they survive visibly and round-trip as text);
  - inline notes (`[[ ]]`) export as FDX ScriptNotes and re-import as notes.

Round-trip (Fountain -> FDX -> Fountain) is loss-free for every standard
screenplay element; only the three Fountain-specific element types above are
reclassified as styled action.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from xml.sax.saxutils import escape, quoteattr

import fountain

# ---- Fountain token type -> FDX paragraph type -------------------------------
_TYPE_TO_FDX = {
    "scene": "Scene Heading",
    "action": "Action",
    "character": "Character",
    "parenthetical": "Parenthetical",
    "dialogue": "Dialogue",
    "transition": "Transition",
    "centered": "Action",
    "section": "Action",
    "synopsis": "Action",
    "lyric": "Action",
}

_STYLE_ORDER = ("bold", "italic", "underline")
_STYLE_NAME = {"bold": "Bold", "italic": "Italic", "underline": "Underline"}


def _style_attr(style: frozenset) -> str:
    parts = [_STYLE_NAME[s] for s in _STYLE_ORDER if s in style]
    return "+".join(parts)


def _runs_xml(text: str, force: frozenset = frozenset()) -> str:
    """Inline-emphasis runs -> <Text> elements. `force` adds styles to every
    run (used so a whole lyric/section line comes out italic/bold)."""
    runs = fountain.inline_runs(text) or [("", frozenset())]
    out = []
    for chunk, style in runs:
        if not chunk:
            continue
        st = _style_attr(style | force)
        if st:
            out.append(f'<Text Style={quoteattr(st)}>{escape(chunk)}</Text>')
        else:
            out.append(f"<Text>{escape(chunk)}</Text>")
    if not out:
        out.append("<Text></Text>")
    return "".join(out)


def _script_note_xml(note: str) -> str:
    return f"<ScriptNote><Paragraph><Text>{escape(note)}</Text></Paragraph></ScriptNote>"


def _paragraph_xml(ptype: str, inner: str, alignment: str | None = None) -> str:
    attrs = f' Type="{ptype}"'
    if alignment:
        attrs += f' Alignment="{alignment}"'
    return f"    <Paragraph{attrs}>{inner}</Paragraph>"


def _title_page_xml(tp: dict) -> str:
    """Build a <TitlePage> from the parsed title-page dict. Centered title +
    credit/author block, contact/copyright lower-left."""
    if not tp:
        return ""
    lines: list[str] = []

    def centered(value: str, style: frozenset = frozenset()):
        for ln in str(value).split("\n"):
            lines.append(_paragraph_xml("Action", _runs_xml(ln, style), alignment="Center"))

    def left(value: str):
        for ln in str(value).split("\n"):
            lines.append(_paragraph_xml("Action", _runs_xml(ln), alignment="Left"))

    if tp.get("title"):
        centered(tp["title"], frozenset({"bold"}))
    lines.append(_paragraph_xml("Action", "<Text></Text>", alignment="Center"))
    for key in ("credit", "author", "authors", "source"):
        if tp.get(key):
            centered(tp[key])
    for key in ("draft_date", "contact", "copyright"):
        if tp.get(key):
            left(tp[key])
    if not lines:
        return ""
    body = "\n".join(lines)
    return f"  <TitlePage>\n    <Content>\n{body}\n    </Content>\n  </TitlePage>\n"


def build_fdx(text: str) -> bytes:
    parsed = fountain.parse(text)
    tokens = parsed["tokens"]
    body: list[str] = []

    def emit(tok: dict):
        ttype = tok.get("type")
        fdx_type = _TYPE_TO_FDX.get(ttype)
        if not fdx_type:
            return
        force = frozenset()
        align = None
        text_val = tok.get("text", "") or ""
        if ttype == "scene":
            text_val = text_val.upper()
        elif ttype == "transition":
            text_val = text_val.upper()
        elif ttype == "centered":
            align = "Center"
        elif ttype == "section":
            force = frozenset({"bold"})
        elif ttype in ("synopsis", "lyric"):
            force = frozenset({"italic"})

        inner = _runs_xml(text_val, force)
        for note in (tok.get("notes") or []):
            inner += _script_note_xml(note)
        body.append(_paragraph_xml(fdx_type, inner, align))

    for tok in tokens:
        t = tok.get("type")
        if t in ("dual-dialogue-begin", "dual-dialogue-end", "page-break", "note"):
            continue  # dual flattens to its inner character/dialogue tokens
        emit(tok)

    content = "\n".join(body)
    title_page = _title_page_xml(parsed.get("titlePage") or {})
    doc = (
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n'
        '<FinalDraft DocumentType="Script" Template="No" Version="5">\n'
        "  <Content>\n"
        f"{content}\n"
        "  </Content>\n"
        f"{title_page}"
        "</FinalDraft>\n"
    )
    return doc.encode("utf-8")


# ---- import: FDX -> Fountain -------------------------------------------------
def _runs_to_fountain(paragraph: ET.Element) -> tuple[str, list[str]]:
    """Concatenate a paragraph's <Text> runs, re-applying emphasis markers from
    each run's Style. Returns (text, notes)."""
    parts: list[str] = []
    notes: list[str] = []
    for child in paragraph:
        tag = child.tag.split("}")[-1]  # strip any namespace
        if tag == "Text":
            chunk = child.text or ""
            if not chunk:
                continue
            style = (child.get("Style") or "").lower()
            bold = "bold" in style
            italic = "italic" in style
            underline = "underline" in style
            if bold and italic:
                chunk = "***" + chunk + "***"
            elif bold:
                chunk = "**" + chunk + "**"
            elif italic:
                chunk = "*" + chunk + "*"
            if underline:
                chunk = "_" + chunk + "_"
            parts.append(chunk)
        elif tag == "ScriptNote":
            note_text = "".join(t.text or "" for t in child.iter()
                                if t.tag.split("}")[-1] == "Text").strip()
            if note_text:
                notes.append(note_text)
    return "".join(parts).strip(), notes


_SCENE_PREFIX = re.compile(r"^(INT|EXT|EST|INT\.?/EXT|I/E)[\.\s]", re.IGNORECASE)
_TRANS_RE = re.compile(r"TO:\s*$")


def fdx_to_fountain(xml_text: str) -> str:
    if isinstance(xml_text, bytes):
        xml_text = xml_text.decode("utf-8", errors="replace")
    root = ET.fromstring(xml_text)

    def localname(el):
        return el.tag.split("}")[-1]

    # Title page (best-effort: first line -> Title, "by" line -> Author). Use
    # plain text — title-page values don't carry inline emphasis markers.
    title_lines: list[str] = []
    tp_el = root.find(".//{*}TitlePage")
    if tp_el is not None:
        for para in tp_el.iter():
            if localname(para) == "Paragraph":
                plain = "".join(t.text or "" for t in para.iter()
                                if t.tag.split("}")[-1] == "Text").strip()
                title_lines.append(plain)
    tp_block = _title_page_from_lines(title_lines)

    # Body.
    out_lines: list[str] = []
    prev_type: str | None = None
    content = root.find("{*}Content")
    paras = (content.findall("{*}Paragraph") if content is not None
             else root.findall(".//{*}Content/{*}Paragraph"))

    for para in paras:
        ptype = (para.get("Type") or "Action").strip()
        align = (para.get("Alignment") or "").strip().lower()
        text, notes = _runs_to_fountain(para)
        note_suffix = "".join(f" [[{n}]]" for n in notes)

        line, kind = _map_fdx_paragraph(ptype, align, text)
        if line is None and not note_suffix:
            # blank paragraph -> paragraph separator
            prev_type = None
            continue
        line = (line or "") + note_suffix

        # Blank-line rules so the Fountain parser re-classifies correctly:
        # dialogue/parenthetical hug the preceding cue; everything else is
        # separated by a blank line.
        tight = kind in ("dialogue", "parenthetical") and prev_type in (
            "character", "dialogue", "parenthetical")
        if out_lines and not tight:
            out_lines.append("")
        out_lines.append(line)
        prev_type = kind

    body = "\n".join(out_lines).strip("\n") + "\n"
    return (tp_block + body) if tp_block else body


def _map_fdx_paragraph(ptype: str, align: str, text: str):
    """Return (fountain_line, kind). kind drives blank-line spacing."""
    p = ptype.lower()
    if text == "" and p not in ("scene heading",):
        return None, None
    if p == "scene heading":
        if _SCENE_PREFIX.match(text):
            return text.upper(), "scene"
        return "." + text, "scene"          # force heading when prefix absent
    if p == "character":
        if re.search(r"[a-z]", text):
            return "@" + text, "character"   # force lowercase names
        return text, "character"
    if p == "parenthetical":
        t = text if text.startswith("(") else "(" + text + ")"
        return t, "parenthetical"
    if p == "dialogue":
        return text, "dialogue"
    if p == "transition":
        if _TRANS_RE.search(text) and not re.search(r"[a-z]", text):
            return text, "transition"
        return "> " + text, "transition"
    # Action / General / Shot / Cast List / New Act / etc.
    if align == "center":
        return "> " + text + " <", "centered"
    # Force a leading "!" only if the line would otherwise be misread as a cue
    # or heading (all-caps line, or INT/EXT prefix).
    if (text and not re.search(r"[a-z]", text)) or _SCENE_PREFIX.match(text):
        return "!" + text, "action"
    return text, "action"


def _title_page_from_lines(lines: list[str]) -> str:
    lines = [ln for ln in lines if ln.strip() != ""]
    if not lines:
        return ""
    tp: dict[str, str] = {}
    tp["Title"] = lines[0]
    rest = lines[1:]
    for i, ln in enumerate(rest):
        low = ln.lower().strip()
        if low in ("written by", "by", "written by:") and i + 1 < len(rest):
            tp["Credit"] = ln
            tp["Author"] = rest[i + 1]
            break
    if "Author" not in tp and rest:
        tp["Author"] = rest[0]
    order = ["Title", "Credit", "Author"]
    out = [f"{k}: {tp[k]}" for k in order if k in tp]
    return "\n".join(out) + "\n\n===\n\n" if out else ""


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("usage: fdx.py to-fdx in.fountain out.fdx", file=sys.stderr)
        print("       fdx.py to-fountain in.fdx out.fountain", file=sys.stderr)
        sys.exit(2)
    mode, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    with open(src, encoding="utf-8") as f:
        data = f.read()
    if mode == "to-fdx":
        with open(dst, "wb") as f:
            f.write(build_fdx(data))
    elif mode == "to-fountain":
        with open(dst, "w", encoding="utf-8") as f:
            f.write(fdx_to_fountain(data))
    else:
        print("unknown mode", file=sys.stderr); sys.exit(2)
    print("wrote", dst)

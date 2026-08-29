"""PDF rendering for parsed Fountain scripts.

Layout/pagination lives in `pagination.py` (shared with static/pagination.js).
This module is a thin draw layer: consume pages → put ink on paper.
"""
from __future__ import annotations

import io

from reportlab.lib.pagesizes import LETTER
from reportlab.pdfgen import canvas

from reportlab.lib.colors import Color, black, lightgrey

import fountain
import pagination
from pagination import CHARS_PER_INCH, LINES_PER_INCH, FormatRules, Block

FONT_REGULAR = "Courier"
FONT_BOLD = "Courier-Bold"
FONT_ITALIC = "Courier-Oblique"
FONT_BOLD_ITALIC = "Courier-BoldOblique"
FONT_SIZE = 12
LINE_HEIGHT = 12  # 12pt single-spaced = 6 lines/inch
DIM_COLOR    = Color(0.55, 0.55, 0.55)
SECTION_COLOR = Color(0.17, 0.42, 0.69)   # matches HTML --accent
SFX_BAR_COLOR   = Color(0.78, 0.61, 0.12)
MUSIC_BAR_COLOR = Color(0.42, 0.55, 0.31)
CUE_BG_COLOR    = Color(0.92, 0.95, 0.99)   # very light blue-tinted

REVISION_COLORS = {
    "white":     None,
    "blue":      Color(0.85, 0.90, 0.96),
    "pink":      Color(0.96, 0.85, 0.88),
    "yellow":    Color(0.99, 0.96, 0.75),
    "green":     Color(0.85, 0.93, 0.85),
    "goldenrod": Color(0.94, 0.85, 0.60),
}


def _fill_page_background(c: canvas.Canvas, color):
    if not color:
        return
    page_w = LETTER[0]
    page_h = LETTER[1]
    c.saveState()
    c.setFillColor(color)
    c.rect(0, 0, page_w, page_h, stroke=0, fill=1)
    c.restoreState()


def _font(b: Block) -> str:
    if b.bold and b.italic:
        return FONT_BOLD_ITALIC
    if b.bold:
        return FONT_BOLD
    if b.italic:
        return FONT_ITALIC
    return FONT_REGULAR


def _draw_block(c: canvas.Canvas, b: Block, x_left_in: float, y_in: float,
                rules: FormatRules) -> float:
    """Draw block lines. y_in is the baseline of the first line."""
    line_h_in = LINE_HEIGHT / 72.0
    page_w_in = LETTER[0] / 72.0

    # ---- block-level visual treatments ----
    # Color & font defaults; some block kinds override below.
    font = _font(b)
    color = black

    if getattr(b, "dim", False):
        color = DIM_COLOR

    if b.kind == "section":
        color = SECTION_COLOR
        font = FONT_BOLD
    elif b.kind == "synopsis":
        color = DIM_COLOR
        font = FONT_ITALIC

    # SFX / MUSIC cue: tinted background block + colored left bar.
    cue_marker = None
    if b.kind == "action" and b.lines and b.lines[0]:
        import re as _re
        m = _re.match(r"^(SFX|MUSIC|FX|SOUND):", b.lines[0], _re.IGNORECASE)
        if m:
            cue_marker = m.group(1).upper()
            font = FONT_BOLD
    if cue_marker:
        bar_color = MUSIC_BAR_COLOR if cue_marker in ("MUSIC",) else SFX_BAR_COLOR
        # Compute block height to size the background.
        block_h = len(b.lines) * line_h_in + 0.05
        # Background fill, sized to span the action column width.
        block_w = rules.actionWidth
        c.saveState()
        c.setFillColor(CUE_BG_COLOR)
        c.rect((x_left_in + b.indentIn - 0.05) * 72,
               (y_in - block_h + line_h_in) * 72,
               (block_w + 0.1) * 72,
               block_h * 72,
               stroke=0, fill=1)
        # Left bar.
        c.setFillColor(bar_color)
        c.rect((x_left_in + b.indentIn - 0.05) * 72,
               (y_in - block_h + line_h_in) * 72,
               0.04 * 72,
               block_h * 72,
               stroke=0, fill=1)
        c.restoreState()

    c.setFont(font, FONT_SIZE)
    c.setFillColor(color)

    for line in b.lines:
        x_in = x_left_in + b.indentIn
        if b.align == "right":
            right_in = page_w_in - rules.right
            text_w_in = len(line) / CHARS_PER_INCH
            x_in = right_in - text_w_in
        elif b.align == "center":
            text_w_in = len(line) / CHARS_PER_INCH
            x_in = (page_w_in - text_w_in) / 2
        c.drawString(x_in * 72, y_in * 72, line)
        if b.underline:
            text_w_in = len(line) / CHARS_PER_INCH
            c.line(x_in * 72, (y_in - 0.01) * 72,
                   (x_in + text_w_in) * 72, (y_in - 0.01) * 72)
        y_in -= line_h_in

    # Section: underline rule beneath the heading.
    if b.kind == "section":
        c.saveState()
        c.setStrokeColor(SECTION_COLOR)
        c.setLineWidth(0.5)
        line_y = (y_in + line_h_in - 0.02) * 72
        c.line((x_left_in + b.indentIn) * 72, line_y,
               (x_left_in + b.indentIn + rules.actionWidth) * 72, line_y)
        c.restoreState()

    c.setFillColor(black)
    return y_in


def _draw_dual(c: canvas.Canvas, b: Block, x_left_in: float, y_in: float,
               rules: FormatRules) -> float:
    half = rules.actionWidth / 2 - 0.2
    cols_chars = pagination.width_chars(half)

    def rewrap_side(side):
        out = []
        for sub in (side or []):
            new = Block(kind=sub.kind,
                        lines=pagination.wrap_lines("\n".join(sub.lines), cols_chars),
                        indentIn=0,
                        align="center" if sub.kind in ("character", "parenthetical") else "left",
                        bold=sub.bold, italic=sub.italic)
            out.append(new)
        return out

    left = rewrap_side(b.left)
    right = rewrap_side(b.right)
    line_h_in = LINE_HEIGHT / 72.0
    y_left = y_in
    for sub in left:
        y_left = _draw_block(c, sub, x_left_in, y_left, rules)
        y_left -= line_h_in
    y_right = y_in
    for sub in right:
        y_right = _draw_block(c, sub, x_left_in + rules.actionWidth / 2 + 0.2, y_right, rules)
        y_right -= line_h_in
    return min(y_left, y_right)


def _draw_title_page(c: canvas.Canvas, tp: dict, rules: FormatRules):
    page_w_in = LETTER[0] / 72.0
    page_h_in = LETTER[1] / 72.0
    c.setFont(FONT_BOLD, FONT_SIZE)

    if tp.get("title"):
        title = str(tp["title"]).upper()
        y = page_h_in * 0.55
        for line in title.split("\n"):
            w = len(line) / CHARS_PER_INCH
            c.drawString(((page_w_in - w) / 2) * 72, y * 72, line)
            y -= LINE_HEIGHT / 72.0

    c.setFont(FONT_REGULAR, FONT_SIZE)
    y = page_h_in * 0.5
    for key in ("credit", "author", "authors", "source"):
        v = tp.get(key)
        if not v:
            continue
        for line in str(v).split("\n"):
            w = len(line) / CHARS_PER_INCH
            c.drawString(((page_w_in - w) / 2) * 72, y * 72, line)
            y -= LINE_HEIGHT / 72.0

    y = rules.bottom + 0.5
    for key in ("contact", "copyright"):
        v = tp.get(key)
        if not v:
            continue
        for line in str(v).split("\n"):
            c.drawString(rules.left * 72, y * 72, line)
            y -= LINE_HEIGHT / 72.0
    if tp.get("draft_date"):
        c.drawString(rules.left * 72, (rules.bottom + 0.2) * 72, str(tp["draft_date"]))
    c.showPage()


def _draw_page_number(c: canvas.Canvas, page_num: int, rules: FormatRules):
    page_w_in = LETTER[0] / 72.0
    page_h_in = LETTER[1] / 72.0
    c.setFont(FONT_REGULAR, FONT_SIZE)
    text = f"{page_num}."
    w = len(text) / CHARS_PER_INCH
    c.drawString((page_w_in - rules.right - w) * 72, (page_h_in - 0.5) * 72, text)


def build_pdf(text: str) -> bytes:
    parsed = fountain.parse(text)
    layout = pagination.paginate_script(parsed)
    rules: FormatRules = layout["rules"]

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    c.setTitle(parsed["titlePage"].get("title") or "Untitled")
    if parsed["titlePage"].get("author"):
        c.setAuthor(str(parsed["titlePage"]["author"]))

    page_h_in = LETTER[1] / 72.0
    line_h_in = LINE_HEIGHT / 72.0

    rev = (parsed["titlePage"].get("revision") or "").lower().strip()
    rev_color = REVISION_COLORS.get(rev)
    scene_counter = 0
    page_w_in = LETTER[0] / 72.0

    for page in layout["pages"]:
        if page.get("isTitlePage"):
            _fill_page_background(c, rev_color)
            _draw_title_page(c, page.get("titlePage", {}), rules)
            continue

        _fill_page_background(c, rev_color)
        y_in = page_h_in - rules.top
        for b in page["blocks"]:
            # Inter-block gap before this block (skip if first).
            if y_in < page_h_in - rules.top:
                gap = pagination.space_before(b, False) * line_h_in
                y_in -= gap

            # Numbers in both margins are a shooting-script convention, so they
            # follow the same rule as slug lines: formats that organise by
            # `#` sections (stage, radio) name their scenes in the heading and
            # get no margin numbers. Matches the CSS for .format-stage /
            # .format-radio, so print and screen agree.
            if b.kind == "scene" and rules.sceneHeadings == "all":
                scene_counter += 1
                num = str(scene_counter)
                c.setFont(FONT_REGULAR, FONT_SIZE)
                c.setFillColor(DIM_COLOR)
                c.drawString((rules.left - 0.5 - len(num) / CHARS_PER_INCH) * 72, y_in * 72, num)
                c.drawString((page_w_in - rules.right + 0.2) * 72, y_in * 72, num)
                c.setFillColor(black)

            if b.kind == "dual":
                y_in = _draw_dual(c, b, rules.left, y_in, rules)
            else:
                y_in = _draw_block(c, b, rules.left, y_in, rules)
            # Inter-block gap after.
            y_in -= pagination.space_after(b) * line_h_in

        if page["pageNumber"] >= 2:
            _draw_page_number(c, page["pageNumber"], rules)
        c.showPage()

    c.save()
    return buf.getvalue()


def _filter_scenes_with_character(tokens: list[dict], character: str) -> list[dict]:
    """Return only scenes (heading + body) that contain the given character."""
    char = character.upper().strip()
    # Group tokens into scene chunks (preamble = tokens before first scene).
    chunks: list[list[dict]] = []
    pre: list[dict] = []
    cur: list[dict] | None = None
    for t in tokens:
        if t.get("type") == "scene":
            if cur is not None:
                chunks.append(cur)
            cur = []
        if cur is None:
            pre.append(t)
        else:
            cur.append(t)
    if cur is not None:
        chunks.append(cur)
    keep = []
    keep.extend(pre)
    for chunk in chunks:
        if any(t.get("type") == "character" and
               (t.get("text") or "").upper().split("(")[0].strip() == char
               for t in chunk):
            keep.extend(chunk)
    return keep


def _mark_dim_for_sides(pages: list[dict], focal: str) -> None:
    """Walk blocks; mark non-focal character/paren/dialogue dim."""
    focal_up = focal.upper().strip()
    for page in pages:
        last_cue = None
        for b in page.get("blocks", []):
            if b.kind == "character":
                last_cue = (b.lines[0] if b.lines else "").upper().split("(")[0].strip()
                if last_cue != focal_up:
                    b.dim = True
                else:
                    b.bold = True
            elif b.kind in ("parenthetical", "dialogue", "more", "contd"):
                if last_cue and last_cue != focal_up:
                    b.dim = True


def build_sides_pdf(text: str, character: str) -> bytes:
    """Per-character sides PDF: only scenes containing the character, with
    non-focal dialogue dimmed."""
    parsed = fountain.parse(text)
    filtered_tokens = _filter_scenes_with_character(parsed["tokens"], character)
    # Inject a 'sides for X' header into the title page.
    tp = dict(parsed.get("titlePage") or {})
    tp["title"] = (tp.get("title") or "Untitled") + " — sides for " + character.upper()
    parsed_filtered = {"titlePage": tp, "tokens": filtered_tokens}
    layout = pagination.paginate_script(parsed_filtered)
    rules: FormatRules = layout["rules"]
    _mark_dim_for_sides(layout["pages"], character)

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    c.setTitle(tp["title"])

    page_h_in = LETTER[1] / 72.0
    line_h_in = LINE_HEIGHT / 72.0

    for page in layout["pages"]:
        if page.get("isTitlePage"):
            _draw_title_page(c, page.get("titlePage", {}), rules)
            continue
        y_in = page_h_in - rules.top
        for b in page["blocks"]:
            if y_in < page_h_in - rules.top:
                y_in -= pagination.space_before(b, False) * line_h_in
            if b.kind == "dual":
                y_in = _draw_dual(c, b, rules.left, y_in, rules)
            else:
                y_in = _draw_block(c, b, rules.left, y_in, rules)
            y_in -= pagination.space_after(b) * line_h_in
        if page["pageNumber"] >= 2:
            _draw_page_number(c, page["pageNumber"], rules)
        c.showPage()
    c.save()
    return buf.getvalue()


def build_cue_sheet_pdf(text: str) -> bytes:
    """A separate document listing every SFX/MUSIC/FX/SOUND cue with the line
    that precedes it. For radio drama production."""
    parsed = fountain.parse(text)
    tokens = parsed["tokens"]
    cues = []
    last_speech = None   # (character, dialogue_line)
    current_char = None
    cue_re = __import__("re").compile(r"^(SFX|MUSIC|FX|SOUND):\s*(.*)$", __import__("re").IGNORECASE)

    for t in tokens:
        if t.get("type") == "character":
            current_char = (t.get("text") or "").replace("\n", " ").strip()
        elif t.get("type") == "dialogue":
            if current_char:
                last_speech = (current_char, (t.get("text") or "").split("\n")[0])
        elif t.get("type") == "action":
            text_line = (t.get("text") or "").strip()
            for paragraph in text_line.split("\n"):
                m = cue_re.match(paragraph.strip())
                if m:
                    cues.append({
                        "kind": m.group(1).upper(),
                        "text": m.group(2).strip(),
                        "after": last_speech,
                    })

    tp = parsed.get("titlePage") or {}
    title = (tp.get("title") or "Untitled") + " — cue sheet"

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    c.setTitle(title)

    page_w_in = LETTER[0] / 72.0
    page_h_in = LETTER[1] / 72.0
    line_h_in = LINE_HEIGHT / 72.0
    margin = 1.0
    y_in = page_h_in - margin

    c.setFont(FONT_BOLD, 16)
    c.drawString(margin * 72, y_in * 72, title.upper())
    y_in -= 24 / 72.0
    c.setFont(FONT_REGULAR, 9)
    c.setFillColor(DIM_COLOR)
    c.drawString(margin * 72, y_in * 72, f"{len(cues)} cues — generated for radio production")
    c.setFillColor(black)
    y_in -= 18 / 72.0

    c.setFont(FONT_REGULAR, FONT_SIZE)
    for i, cue in enumerate(cues, start=1):
        if y_in < margin + 0.5:
            c.showPage()
            y_in = page_h_in - margin
            c.setFont(FONT_REGULAR, FONT_SIZE)
        c.setFont(FONT_BOLD, FONT_SIZE)
        c.drawString(margin * 72, y_in * 72, f"Cue {i:>3}  {cue['kind']}:")
        c.setFont(FONT_REGULAR, FONT_SIZE)
        # The cue text wraps within remaining width.
        avail = page_w_in - margin * 2 - 1.5
        wrapped = pagination.wrap_lines(cue["text"], int(avail * CHARS_PER_INCH))
        first = True
        for line in wrapped:
            if first:
                c.drawString((margin + 1.5) * 72, y_in * 72, line)
                first = False
            else:
                y_in -= line_h_in
                c.drawString((margin + 1.5) * 72, y_in * 72, line)
        y_in -= line_h_in
        if cue["after"]:
            ch, line = cue["after"]
            c.setFillColor(DIM_COLOR)
            c.drawString((margin + 1.5) * 72, y_in * 72, f"after {ch}: “{line[:80]}”")
            c.setFillColor(black)
            y_in -= line_h_in
        y_in -= line_h_in * 0.5
    c.save()
    return buf.getvalue()


if __name__ == "__main__":
    import sys
    if len(sys.argv) < 3:
        print("usage: pdf_layout.py in.fountain out.pdf", file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1], encoding="utf-8") as f:
        data = build_pdf(f.read())
    with open(sys.argv[2], "wb") as f:
        f.write(data)
    print(f"wrote {sys.argv[2]} ({len(data)} bytes)")

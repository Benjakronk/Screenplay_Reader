# Faaglarna — plan

A standalone app for writing and reading scripts: screenplays (film/TV), stage
plays, and radio/audio drama. Authors in **Fountain** (the industry-standard
plain-text format), renders to a polished, format-appropriate page view.

Sibling to `Textbook_Reader/`. Lives in `Faaglarna/` and reuses ideas
(not code paths) from the parent markdown reader — copy what's useful, diverge
where the domain demands it.

## Goals

- **Author**: editor with live preview, file tree, save, version history, drag
  images (for stage diagrams, storyboards). Fountain syntax with helpful
  affordances (auto-uppercase character names, tab cycles element type, etc.).
- **Read**: a polished "performance mode" — fixed-pitch, courier-style font,
  proper margins, page breaks every ~55 lines (screenplay) / per-act (stage),
  print-ready. Bookmarks, "resume where I left off," scene jump list.
- **Multi-format**: same Fountain source can render as screenplay, stage play,
  or radio drama — controlled by a frontmatter `format:` key, with sensible
  per-format defaults (font, page rules, what to bold/italicize).
- **Local-first**: same model as the parent app — files live in a local folder,
  Python server, no accounts, no cloud.

## Non-goals

- Final Draft `.fdx` import/export (out of scope for v1; revisit later).
- Collaboration / multi-user editing.
- Re-implementing Markdown features that don't make sense in scripts (wikilink
  graph, daily notes, tags-as-taxonomy). Keep the surface small.

## Why Fountain

Fountain is plain-text screenplay markup. Structure is inferred from
formatting, so files stay readable in any editor and are portable to other
tools (Highland, Slugline, afterwriting.com, KIT Scenarist).

Minimal spec we'll implement:

```
Title Page (key: value pairs, optional)
Title: The Quiet Kitchen
Author: Benjamin Ensrud
===                              ← title page separator

INT. KITCHEN - DAY               ← scene heading: INT/EXT/EST + location + time
                                 ← also: `.FORCED HEADING` (leading dot)

Anna stares at the kettle.       ← action (any paragraph that isn't another element)

ANNA                             ← character (ALL CAPS line, blank line above)
(whispering)                     ← parenthetical
Did you hear that?               ← dialogue (line directly under character)

BEN ^                            ← `^` = dual dialogue (side-by-side with prior)
No. What?

> CUT TO:                        ← transition (forced with `>`, or ends in "TO:")

# Act One                        ← section (outline; not rendered in script)
= A quiet beginning              ← synopsis (outline only)

[[note to self]]                 ← inline note (hidden in performance mode)

/* boneyard */                   ← excluded entirely from render
```

For stage and radio we'll bend Fountain:

- **Stage**: section headings (`# Act 1`, `## Scene 2`) become real act/scene
  markers in the render. Character names are left-aligned (not centered).
  Stage directions are italicized in parentheses inline, or as action blocks.
- **Radio**: character cues left-aligned, `SFX:` and `MUSIC:` prefixes get
  special styling (bold, often uppercase). No scene slug lines.

These are render-time choices driven by `format:` in the title page — the
Fountain source stays canonical.

## Architecture

Tiny Python server (mirrors the parent's `server.py` shape, much slimmer)
plus a static frontend. **Not** static-only like Textbook_Reader, because
authoring needs writes.

```
Faaglarna/
  README.md
  server.py                 # slim: tree, file CRUD, history, upload, /api/export/pdf
  fountain.py               # parser (Python port, used by PDF exporter)
  pdf_layout.py             # ReportLab layout per format
  tests/
    fountain/               # shared (input, expected tokens) fixtures
  scripts/                  # the user's script library
    _assets/
    .history/
    sample-screenplay.fountain
    sample-stageplay.fountain
    sample-radio.fountain
  static/
    index.html
    app.js                  # editor + renderer
    fountain.js             # parser (canonical impl, mirrored by fountain.py)
    style.css               # screenplay/stage/radio render styles
    print.css               # browser-print fallback only; PDF export is the real path
    icon.svg
```

File extension: `.fountain` (canonical). Also accept `.spmd` and `.txt`.

## Fountain parser

**Write our own**, in JS, vendored as `static/fountain.js`. Fountain's grammar
is small (~12 element types) and writing it ourselves means:

- Bending the parser for stage/radio without fighting an upstream API.
- One token stream shared between the renderer (`app.js`) and the PDF
  exporter (server-side, see below) — easier to keep them in sync.
- Zero external dependencies; matches the rest of the project.

Architecture: a pure function `parse(text) → { titlePage, tokens }` where
`tokens` is a flat array of `{ type, text, ... }`. Two passes:

1. **Lex**: split into lines, peel off title page (everything before the
   first `===`), strip boneyards (`/* ... */`), capture notes (`[[ ... ]]`)
   as inline markers.
2. **Classify**: walk lines, emit tokens using Fountain's rules. Context
   matters — a character line is only valid with a blank line above and a
   non-blank line below — so the classifier is a small state machine, not a
   per-line regex sweep.

Element types we emit: `scene`, `action`, `character`, `parenthetical`,
`dialogue`, `dual-dialogue-begin/end`, `transition`, `section`, `synopsis`,
`note`, `page-break`, `lyric`, `centered`.

Inline emphasis (`*italic*`, `**bold**`, `***bold-italic***`, `_underline_`)
is handled in a second mini-pass over the text content of each token.

A small JSON corpus of `(input, expected tokens)` pairs lives in
`tests/fountain/` and is run via `python -m unittest` against a Python port
of the parser used by the PDF exporter — keeping the two implementations
honest. Same fixtures double as JS unit tests in the browser.

## Render pipeline

1. Read raw `.fountain` text.
2. Strip and parse title page (key: value pairs above the first `===`).
3. Tokenize body into elements: scene, action, character, parenthetical,
   dialogue, dual-dialogue, transition, section, synopsis, note, page-break.
4. Apply format-specific transforms:
   - `screenplay`: center character/dialogue, ALL CAPS slug lines, CUT TO:
     right-aligned, paginate every ~55 printed lines.
   - `stage`: left-align character/dialogue, italicize stage directions,
     paginate per scene/act.
   - `radio`: left-align cues, highlight SFX/MUSIC, no slug lines.
5. Emit HTML into the preview pane. Same DOM used for the print stylesheet —
   what you see is what prints.

Page-break logic for screenplays: count rendered lines (after wrap) within
each element, never break inside dialogue or between character and their
first line. If splitting dialogue across pages, emit `(MORE)` / `(CONT'D)`.

## PDF export

A first-class feature, not a "print and pray" fallback. Browsers disagree on
print CSS (especially `@page` margins, `widows`/`orphans`, and font metrics)
and screenplay submission standards demand exact margins — so we render PDFs
server-side from the same parsed token stream the browser uses.

**Approach**: ReportLab (pure Python, no system deps). The server imports a
Python port of `fountain.js` (`fountain.py`) and a layout module
(`pdf_layout.py`) that consumes the token stream and emits a PDF with
format-specific rules.

Industry conventions baked in per format:

| Format     | Page   | Font          | Left   | Right  | Top  | Bottom | Lines/pg |
|------------|--------|---------------|--------|--------|------|--------|----------|
| screenplay | US Letter | Courier 12pt | 1.5"   | 1.0"   | 1.0" | 1.0"   | ~55      |
| stage      | US Letter | Courier 12pt | 1.25"  | 1.25"  | 1.0" | 1.0"   | per-scene |
| radio      | US Letter | Courier 12pt | 1.25"  | 1.0"   | 1.0" | 1.0"   | per-scene |

Element placement (screenplay defaults; stage/radio override):

- Scene heading: left margin, ALL CAPS, blank line before.
- Action: left margin, wraps at right margin.
- Character: indented 2.2" from left, ALL CAPS.
- Parenthetical: indented 1.6" from left.
- Dialogue: indented 1.0" from left, max width ~3.3".
- Transition: right-aligned.
- Dual dialogue: two columns side-by-side, each ~2.5" wide.
- Page number: top-right corner, starting on page 2.
- Title page: separate first page, vertically centered block.

Pagination rule (screenplay): never split a character/dialogue block such
that the character line ends a page. If dialogue must split, emit `(MORE)`
at the bottom and `CHARACTER (CONT'D)` at the top of the next page. Never
break a parenthetical from its dialogue. Action blocks can break, but
prefer not to leave a single line orphaned.

Endpoint: `POST /api/export/pdf` with `{ path }` → returns
`application/pdf`. The frontend offers an "Export PDF" button that hits
this endpoint and triggers a download. Watermark / draft toggle, scene
numbers on/off, and "include title page" toggle live in an export dialog.

## What to keep vs cut from the parent app

**Keep (port the patterns, not necessarily the code):**

- File tree sidebar, search, recent files.
- Version history (`.history/` snapshots on save).
- Image upload to `_assets/`.
- Theme + font size controls. Focus mode.
- Editor↔preview split view, scroll-sync.
- Path-safety helpers from `server.py`.

**Cut:**

- Markdown-specific rendering (marked, KaTeX, Mermaid). Replaced by Fountain.
- Wikilinks, backlinks, graph view, tags taxonomy, daily notes.
- Find & replace project-wide (single-file find-in-document is enough for v1).
- Frontmatter UI tied to Obsidian-style tags.

**Add (script-specific):**

- Editor smarts: tab cycles "scene → action → character → dialogue →
  parenthetical → transition" on the current line; auto-uppercase character
  names; auto-complete character names you've used; `(CONT'D)` insertion;
  pressing Enter after a character line drops you into dialogue mode.
- Outline view: collapsible tree of sections / scenes / synopses (built from
  `#`, `##`, `=`). Click to jump.
- Scene navigator: dropdown of all slug lines, current scene highlighted as
  you scroll.
- Character report: who appears in which scenes, line counts, longest
  monologues. Useful for casting and rehearsal planning.
- Production stats panel: page count estimate, scene count, location count,
  est. runtime (1 page ≈ 1 minute for screenplay; configurable WPM for stage).
- Performance / read mode: hides editor chrome, big serif/courier render,
  optional auto-scroll for rehearsal. Bookmarks per script.
- Multi-format render via `format:` title-page key (`screenplay` | `stage` |
  `radio`).
- Print stylesheet that produces industry-standard margins per format.

## Phased build

**Phase 1 — Parser + scaffold.**
- Scaffold `Faaglarna/`. Copy `server.py` from the parent, strip
  Markdown-specific endpoints, point file root at `scripts/`.
- Write `fountain.js` against a fixture corpus. Render screenplay HTML in
  the browser from a seed `sample-screenplay.fountain`. No editor yet.

**Phase 2 — Editor.**
- Textarea editor, save + history, split view + scroll-sync.
- Editor smarts: tab cycle, auto-uppercase character, character autocomplete,
  `(CONT'D)` insertion.

**Phase 3 — PDF export.**
- Port `fountain.js` to `fountain.py` against the same fixture corpus.
- Write `pdf_layout.py` (ReportLab) for screenplay format. `POST /api/export/pdf`
  endpoint. Frontend "Export PDF" button + options dialog.

**Phase 4 — Multi-format.**
- `format:` title-page key drives render variant. Stage + radio HTML styles
  and `pdf_layout.py` variants. Sample files for each format.

**Phase 5 — Navigation and stats.**
- Outline, scene navigator, character report, production stats panel.

**Phase 6 — Performance/read mode + polish.**
- Read-only mode with bookmarks, resume, auto-scroll. Mobile pass. Docs.

**Phase 7 — Cloud backend + live collaboration.** (built)
- A third backend beside the local server and the offline store: Node + Express
  + PostgreSQL on the VPS, serving the same `/api/*` contract so `app.js`'s data
  layer is unchanged. `static/backend.js` picks between the three.
- Content becomes a CRDT (Yjs) rather than a file: `doc_state.ydoc` is the
  source of truth and plain text is derived from it on demand. Concurrent edits
  merge instead of racing, so the 409 conflict path never fires in cloud mode.
- Invite-only accounts; per-document `owner`/`editor`/`viewer`, enforced
  server-side including on the collaboration socket.
- PDF/FDX rendering stays in Python: a stateless localhost sidecar imports
  `pdf_layout.py` and `fdx.py` unchanged, so there is no second implementation.
- See `README.md` “Cloud mode” and `server-node/deploy/README-deploy.md`.

## Decisions

- **Name**: `Faaglarna/`. Swedish *fåglarna*, "the birds", after the
  Aristophanes play. Written with `aa` rather than `å` so the repo name,
  URLs, and any package identifiers stay ASCII.
- **Parser**: hand-written, in both JS (`fountain.js`, canonical) and Python
  (`fountain.py`, used by the PDF exporter). Shared fixture corpus keeps
  them in lockstep.
- **PDF export**: server-side via ReportLab, sharing the parser's token
  stream. Exposed as `POST /api/export/pdf`. Browser print is a fallback,
  not the primary path.
- **Seed content**: one short sample per format —
  `sample-screenplay.fountain`, `sample-stageplay.fountain`,
  `sample-radio.fountain` — committed under `scripts/`. They double as
  smoke tests for the renderer and PDF exporter.

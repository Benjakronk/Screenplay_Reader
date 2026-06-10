# Screenplay Reader

Local-first authoring and reading for screenplays, stage plays, and radio
drama. Sibling to the parent markdown reader; doesn't share code, by design.

## Run

```
python server.py
```

Opens `http://127.0.0.1:8766/`. Scripts live in `./scripts/` and are watched
implicitly (refresh button reloads the tree). Version snapshots accumulate
under `./scripts/.history/` on every save.

## Host it online (no server)

The frontend also runs as a fully static site — no Python, no backend — so you
can publish it on GitHub Pages for someone to write and read scripts in their
browser. The same files power both modes: `static/backend.js` detects whether a
server is answering and, if not, transparently stores everything in the
browser's own database (IndexedDB).

To publish:

1. In the repo on GitHub: **Settings → Pages → Build and deployment →
   Source: GitHub Actions**.
2. Push to `main`. The workflow in `.github/workflows/pages.yml` deploys the
   `static/` folder. The app appears at
   `https://<your-user>.github.io/<repo>/`.

What changes in static (browser) mode:

- **Storage** — scripts and version history live in *that browser* on *that
  device*. There are no accounts and nothing is uploaded anywhere.
- **Move / back up** — sidebar buttons: **Import** a `.fountain` file from disk,
  **Export** the open script back to disk, **Backup** every script to one JSON
  file, and **Restore** from that backup. Clearing browser data erases scripts,
  so back up to share or to switch devices.
- **PDF** — the `↓ PDF` button (and `Ctrl+P`) opens the browser's print dialog;
  choose *Save as PDF*. Pagination — including forced `===` page breaks — is
  preserved because the print output is the same paginated pages shown on screen.
- **Not available offline** — server-only features (Final Draft `.fdx`
  import/export, character sides, cue sheets) are hidden or disabled in static
  mode; run `python server.py` locally for those.

Running `python server.py` locally is unchanged — the real endpoints answer
first, so `backend.js` stays dormant and every desktop feature still works.

## File format

Fountain (`.fountain`). The parser also accepts `.spmd` and `.txt`. See
[fountain.io/syntax](https://fountain.io/syntax) for the language; samples
under `scripts/` exercise every element type.

A document begins with an optional title page (`key: value` block ended by
`===` or a blank line), then the body. The `format:` key selects the render
variant:

```
Title: My Play
Author: Me
Format: stage         # or: screenplay (default), radio
===

# Act One

ELENA
Hello.
```

## Features

- **Editor**: Fountain-aware textarea. Tab cycles the current line's element
  type. Auto-complete suggests character names you've used.
- **Live preview**: split mode shows source ↔ rendered page side-by-side
  with scroll sync.
- **Version history**: saves snapshot the prior version; restore or diff from
  the history modal. Auto-saves are throttled (≈5 min between snapshots, capped
  per file) so the timeline stays meaningful; manual `Ctrl+S` always
  checkpoints. Saves detect on-disk changes and ask before overwriting.
- **Multi-format rendering**: screenplay (centered cues, 1.5" left margin),
  stage (left-aligned cues, italicized stage directions), radio (cue
  highlights for `SFX:` / `MUSIC:`).
- **PDF export**: server-side, ReportLab, industry margins per format. Page
  splits never orphan a character cue; long dialogue gets `(MORE)` /
  `(CONT'D)`.
- **Final Draft (.fdx)**: import and export the industry-standard interchange
  format. Round-trip is loss-free for all standard screenplay elements;
  Fountain-specific bits (sections, synopses, lyrics) export as styled action
  and dual dialogue flattens to sequential cues. Import lands as a new
  `.fountain` file.
- **Navigation**: outline panel (sections, scenes, synopses), scene-jump
  dropdown, character report with cue/line/word/scene counts per role,
  location frequency.
- **Production tools** (command palette, `Ctrl+K`): cast list / dramatis
  personae (copy or insert), notes review (every `[[note]]`, click to jump),
  format-aware runtime estimate in the stats panel, and a spellcheck toggle.
  Live page/scene/character/word counts in the status bar.
- **Performance mode**: full-screen, sidebar hidden, larger type. Useful
  for rehearsal. `P` toggles, `Esc` exits.
- **Bookmarks + resume**: `B` bookmarks current scroll position; the app
  remembers the last script opened and where you were in it.

## Keyboard

| Key       | Action                                  |
|-----------|-----------------------------------------|
| Ctrl+S    | Save                                    |
| Tab       | Cycle current line's element type (editor) |
| B         | Bookmark current view position          |
| P         | Toggle performance mode                 |
| Esc       | Exit performance mode / close modal     |

## Layout

```
Screenplay_Reader/
  server.py               # HTTP server (file CRUD, history, exports, fdx import)
  fountain.py             # parser (Python, drives PDF + fdx)
  pdf_layout.py           # ReportLab layout per format
  fdx.py                  # Final Draft (.fdx) import/export
  tests/fountain/         # shared fixture corpus
    basic.json            # input → expected tokens
    runner.html           # browser test runner
    test_python.py        # Python parser tests
  scripts/                # your scripts go here
    _assets/              # images
    .history/             # save snapshots (auto)
    sample-*.fountain     # seed examples
  static/
    fountain.js           # parser (JS — canonical, drives the renderer)
    pagination.js         # page layout (drives on-screen pages + print)
    app.js                # frontend logic
    backend.js            # static-mode store (IndexedDB) + print export; inert under the server
    index.html
    style.css
    icon.svg
  .github/workflows/
    pages.yml             # deploys static/ to GitHub Pages
```

## Development

Both parsers share `tests/fountain/basic.json` as their fixture corpus.
After any parser change run both test suites and make sure they agree:

```
python tests/fountain/test_python.py
# Then open http://127.0.0.1:8766/tests/fountain/runner.html in a browser
```

Adding new Fountain syntax requires changes in both `static/fountain.js`
and `fountain.py`; the shared fixtures catch drift.

## Dependencies

- Python ≥ 3.10
- `reportlab` (PDF export)

No client-side dependencies — the frontend is hand-written vanilla JS.

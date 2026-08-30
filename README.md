# Faaglarna

Local-first authoring and reading for screenplays, stage plays, and radio
drama. Sibling to the parent markdown reader; doesn't share code, by design.

Named for *fåglarna* — "the birds", after the Aristophanes play, and after a
grandfather who used the word for stubbed toes.

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
- **Beat board** (`📇`): every scene as a card showing its first paragraph in
  full, dragged to reorder. Takes the whole window while open.
- **Install it**: on iOS use Safari's Share → *Add to Home Screen*; Android and
  desktop Chrome/Edge offer *Install*. It then opens in its own window, and the
  app shell is cached so it starts without a network — where it falls back to
  the same offline storage described above.
- **Phone and tablet**: the sidebar becomes a drawer, one pane shows at a time,
  and on a phone the script reflows into a single readable column rather than
  shrinking an 8.5-inch page onto a 6-inch screen. Rotate to landscape for the
  real paginated pages.

## Keyboard

| Key       | Action                                  |
|-----------|-----------------------------------------|
| Ctrl+S    | Save                                    |
| Tab       | Cycle current line's element type (editor) |
| B         | Bookmark current view position          |
| P         | Toggle performance mode                 |
| Esc       | Exit performance mode / close modal     |

## Cloud mode (accounts + live collaboration)

Optional third backend. With it, scripts live on your own server, several people
can edit the same script **at the same time**, and edits merge without anyone
overwriting anyone — the document is a CRDT (Yjs), not a file being raced over.

The app picks its backend at startup, in this order:

| Condition | Backend |
|---|---|
| A server answers `/api/tree` on this origin | the local Python server (`python server.py`) |
| `static/config.js` names a cloud API and you sign in | the cloud backend |
| neither | the offline IndexedDB store |

Declining the sign-in prompt lands you on the offline store, so **an account is
only ever needed to collaborate — never to use the app.** Leaving
`static/config.js` empty removes cloud mode entirely.

Signing in is invite-only: there is no public registration endpoint. You create
the first account on the server with `create-user.js`, and everyone after that
gets an invite link from the Share dialog.

To set it up, see [`server-node/deploy/README-deploy.md`](server-node/deploy/README-deploy.md).
It needs a domain, a Postgres database, and two pm2 services on a VPS. For why it
is built the way it is — the decisions, the trade-offs, and how far the tests go —
see [`docs/cloud-architecture.html`](docs/cloud-architecture.html) — open it in a
browser for the diagrams — or the same material as prose in
[`docs/cloud-architecture.md`](docs/cloud-architecture.md).

What changes when you are signed in:

- **Live editing.** Everyone's text syncs as they type; collaborator initials
  appear in the toolbar. Remote carets are not drawn inside the editor.
- **Undo is yours alone.** Ctrl+Z reverts only your own edits, never a
  collaborator's.
- **Save means "mark a version".** Your text is already saved continuously, so
  Ctrl+S records a named version instead — which is what the history panel then
  lists. Because a CRDT merges concurrent edits, the "changed on disk" conflict
  prompt never appears.
- **Sharing.** Scripts other people shared with you appear under `Shared/`.
  Access is `editor` or `viewer`; a viewer's writes are refused by the server,
  not just hidden in the UI.
- **Your work stays yours.** The sidebar has **⤴ Export** to download the open
  script as a plain `.fountain` file, **💾 Backup** to download every script you
  own as one JSON archive, and **⤵ Import** / **☁ Import backup** to bring
  either back in. Nothing is trapped in the cloud: a screenplay is a text file,
  and you can always hold a copy.
- **Comments and suggestions.** Select text and *Comment on selection* to start
  a thread. `✎` turns on suggest mode: what you type is proposed rather than
  applied, in green for additions and struck-through red for removals, and each
  suggestion carries its own thread explaining why. `💬` opens both side by side.
  A resolved suggestion is kept, with who decided and the reasoning intact.
- **Who wrote what.** `▤` stripes the margin by author and lists each person's
  share of the script. The version history names who contributed to each saved
  version, not just who pressed save.
- **Inviting is an administrator's job.** Anyone can share a script with someone
  who already has an account — the dialog lists them. Bringing a *new* person in
  creates an account on this server, so it takes an administrator
  (`node create-user.js <email> --admin` on the box).
- **Your account.** The initial in the toolbar opens a dialog to change your
  password or sign out. Changing it requires the current one and signs you out
  everywhere else, so it doubles as "evict whoever else is signed in as me".
  There is no email-based reset: a forgotten password is recovered by re-running
  `create-user.js` on the server.

## Layout

```
Faaglarna/
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
    backend.js            # picks the backend; offline store (IndexedDB) + print export
    config.js             # where the cloud API lives (empty = cloud mode off)
    cloud.js              # accounts, sharing, collaboration lifecycle
    collab.js             # Y.Text <-> textarea binding
    vendor/
      collab-bundle.js    # generated: Yjs + Hocuspocus provider (see collab/)
    index.html
    style.css
    icon.svg
  server-node/            # the cloud backend (optional — see Cloud mode)
    server.js             # REST API, same /api/* contract as server.py
    db.js  auth.js  docs.js  collab.js
    deploy/README-deploy.md
  export-service/         # stateless PDF/FDX sidecar; reuses the modules above
    export_server.py
  collab/                 # build + tests for the browser Yjs bundle
  docs/
    cloud-architecture.html # why the cloud backend looks like this (with diagrams)
    cloud-architecture.md   # the same, as prose
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

The cloud backend has its own suites, and neither needs a database server or a
network — they run against an in-process Postgres (PGlite) and real local
WebSockets:

```
cd server-node && npm install && npm test    # REST API + collaboration server
cd collab      && npm install && npm test    # the Y.Text <-> textarea binding
```

Add `EXPORT_SERVICE_URL=http://127.0.0.1:3002` with the sidecar running
(`python export-service/export_server.py`) to also cover real PDF/FDX rendering.

`static/vendor/collab-bundle.js` is generated and committed, so the frontend
still needs no build step. Regenerate it after changing the pinned versions:

```
cd collab && npm run build
```

## Dependencies

The app itself, as always:

- Python ≥ 3.10
- `reportlab` (PDF export) — the only third-party Python package
- No client-side dependencies. The frontend is hand-written vanilla JS and
  loads as plain scripts, with no build step.

Only if you run the **cloud backend**:

- Node ≥ 20, PostgreSQL ≥ 15
- `express`, `pg`, `yjs`, `@hocuspocus/server` (all MIT)
- Yjs reaches the browser through the committed bundle above, fetched on demand
  so offline visitors never download it.

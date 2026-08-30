# Cloud backend — architecture and decisions

> There is a nicer-reading version of this same material next to it:
> **[`cloud-architecture.html`](cloud-architecture.html)** — open it in a browser for
> the diagrams. The two are parallel documents, not generated from each other, so a
> change to the architecture needs applying to both.

Written August 2026, when the cloud backend was built. This is the *why* document:
what was chosen, what was rejected, and what is verified. For **how to run it**,
see [`../server-node/deploy/README-deploy.md`](../server-node/deploy/README-deploy.md);
for **what it does**, see the "Cloud mode" section of [`../README.md`](../README.md).

## The problem

Faaglarna had two backends and no way to write with anyone.

- **Local Python server** (`server.py`) — files on disk under `scripts/`.
- **Offline build** — the same frontend on GitHub Pages, with `static/backend.js`
  serving every `/api/*` call from IndexedDB.

Neither survived losing a browser profile, and neither let two people open the
same script. The goal was a third backend on the existing Netcup VPS: durable
storage, accounts for named collaborators, and simultaneous editing.

## The two findings that shaped everything

Both came out of reading the existing code before designing anything, and both
made the job far smaller than it first looked.

**1. `backend.js` already monkey-patches `window.fetch`.** Every one of app.js's
~20 `fetch('/api/...')` calls goes through it, and it already had `detect()` and
`adaptUi()` for switching behaviour per mode. Cloud mode became a third branch
in a seam that already existed: rewrite the URL onto the API origin, attach a
bearer token. **app.js's data layer needed no changes at all.**

**2. `markDirty()` is already the universal mutation hook.** Fifteen places in
app.js assign to the textarea. Nine call `markDirty()` immediately after; five
are document load/clear, which must *not* reach the CRDT; one —
`applySmartUppercase` (app.js:948) — mutates without it. So syncing local edits
into the CRDT is one wrapper around `markDirty` plus one around
`applySmartUppercase`, instead of fifteen separate rewrites.

> `applySmartUppercase` not calling `markDirty` is a real pre-existing bug in
> every mode: that edit never schedules an autosave on its own. The wrapper
> incidentally fixes it in cloud mode; the local and offline modes still have it.

## How a backend is chosen

`static/backend.js` decides once at boot, in priority order:

| Test | Result |
|---|---|
| A server answers `/api/tree` on this origin | `server` — the local Python app; the shim stays inert |
| `static/config.js` names a cloud API **and** a session validates (or the user signs in) | `cloud` |
| neither | `static` — the offline IndexedDB store |

Declining the sign-in prompt lands on `static`. **An account is only ever needed
to collaborate, never to use the app.** Leaving `config.js` empty removes cloud
mode entirely — which is also the instant rollback.

The fetch wrapper `await`s that decision before routing any `/api/*` call.
Without it, a request made during the probe would be answered by the wrong
backend.

## Topology

```
browser                                   Netcup VPS
┌──────────────────────┐                  ┌─────────────────────────────────────┐
│ app.js  (unchanged)  │                  │ nginx :443  faaglarna.lektorensrud.no│
│   fetch('/api/...')  │   HTTPS          │   ├─ /         -> /srv/faaglarna-web │
│        │             │─────────────────►│   ├─ /api/     -> Node :3001        │
│   backend.js shim ───┤                  │   └─ = /collab -> Node :3003 (WS)   │
│     ├ local server   │                  │                                     │
│     ├ cloud          │                  │ one Node process, two listeners     │
│     └ offline (IDB)  │   WebSocket      │   :3001 REST - auth, docs, history  │
│                      │─────────────────►│   :3003 Hocuspocus (Yjs)            │
│   collab.js          │                  │        │                            │
│     Y.Text <-> textarea                 │        └─ /api/export/* ──┐         │
└──────────────────────┘                  │                          ▼          │
                                          │ Python :3002 (stateless)  PostgreSQL│
                                          │   ReportLab + fdx         faaglarna │
                                          └─────────────────────────────────────┘
```

**Frontend and API share one origin.** There is no cross-origin request at all:
no preflights, no `ALLOWED_ORIGINS` to keep in step with the frontend's address,
and no way to get CORS subtly wrong. The CORS middleware stays in place and
simply never has to act.

## Decisions

### The frontend is served from the VPS, not GitHub Pages

It started on Pages. Pages never issued a certificate for the custom domain: its
checker reported `NotServedByPagesError` while GitHub's own edge servers returned
HTTP 200 for that exact hostname, and `benjakronk.github.io/<repo>/` returned a
301 to it. DNS was a single clean CNAME with no conflicting records and no CAA
anywhere. Removing and re-adding the domain did not clear it, and the account's
plan has no support route for Pages.

Rather than keep waiting on a checker contradicted by the servers behind it, the
frontend moved onto the box already running the API. That turned out to be the
better architecture anyway - one origin removes the whole CORS surface - so the
outage prompted a change worth making regardless.

Cost: a push no longer deploys the site on its own. `git pull` on the box does.
The repo is public, so that needs no credentials, and the deployed commit stays
identifiable.

### The Y.Doc is the source of truth, not a text column

`doc_state.ydoc` (BYTEA) holds the CRDT. Plain text is *derived* from it on
demand for exports, version snapshots and `/api/file` — never stored alongside
it. There is no cache to go stale.

Reads go through `collab.readText()`, which opens a Hocuspocus *direct
connection*: that serves the in-memory document when one is loaded and falls
back to the database when it isn't. Reading `doc_state` directly would return a
copy up to one debounce interval old, which would silently export stale PDFs.

### `/api/save` changed meaning instead of disappearing

- **autosave** (`auto: true`) → 200, no-op. The CRDT already persisted continuously.
- **manual Ctrl+S** → materialise the text and write a `doc_versions` row.

This gives the existing history UI a natural cloud meaning — manual saves are
named versions — without touching it. The 409 "changed on disk" conflict path in
app.js becomes unreachable, which is correct: a CRDT merges concurrent edits
rather than racing over a whole file.

### Undo is per-user

app.js's undo stack (`_histUndo`) snapshots the **whole document**. Replaying one
in a shared script would also wipe out whatever a collaborator typed meanwhile.
Cloud mode delegates `histUndo`/`histRedo` to Yjs's `UndoManager`, scoped with
`trackedOrigins` to this browser's own edits. Outside cloud mode app.js's own
stack is used unchanged.

### The textarea stayed; no CodeMirror rewrite

Considered and rejected. CodeMirror 6 + `y-codemirror.next` would give remote
carets drawn inline and Fountain syntax highlighting, but costs rewriting ~125
editor call sites onto its transaction API. Given that `markDirty` covers nine
of ten mutation paths, the textarea binding was a fraction of the work.

**The cost of that choice:** no remote carets inside the editor. Collaborator
initials appear in the toolbar instead. If that ever stops being enough,
CodeMirror is the upgrade path and the server side needs no changes.

### Local edits are diffed, not intercepted

`syncFromTextarea()` diffs the textarea against what the CRDT last held and
applies the single differing span. The alternative — describing each of the
fifteen mutation sites as an explicit range operation — is fragile: one missed
site silently desyncs the document with no error.

The diff trims a common prefix and a common suffix, which is O(n) in two scans.
Every real edit (a keystroke, a Tab-cycle, a find/replace hit) is one contiguous
change, so this locates it exactly. At screenplay sizes it is far below the cost
of the re-render that follows.

Remote edits patch back with `setRangeText(..., 'preserve')`, which replaces only
the changed span and lets the browser adjust the selection. A blunt
`ta.value = next` would drop the caret to position 0 every time a collaborator
typed.

### LF is the only line ending the shared text may hold

Not a style preference — an invariant forced by the editor, and the one place
where keeping the textarea has a sharp edge.

A `<textarea>` normalises its value: the HTML spec turns CR and CRLF into LF,
both on assignment and through `setRangeText`. So a CRDT holding CRLF describes
a document the browser can never reproduce. The two then disagree about how many
characters exist, and **every offset crossing between them is wrong by the
number of line breaks above it** — a typed edit, a comment anchor, a suggestion
range. The edit lands silently in the wrong place; nothing throws.

A script imported from a Windows `.fountain` file held 1430 CRLF pairs. Typing
`ganske ` before `avventende` wrote `Roligganske e avventende`, two characters
early — one per CRLF above that point. Deeper in the document the error passed a
thousand characters. A document created in the app was unaffected, which is why
this looked like a collaboration fault rather than a text fault.

`docs.js` keeps CRLF out at every point where whole text enters a document
(import, restore, seeding); `collab.js` heals documents seeded before that gate
existed. Deleting a CR is safe from any client: two of them delete the same CRDT
item, which merges to one deletion rather than two.

Comment and suggestion anchors made this hard to see. The error is applied
twice — once recording a browser offset into the CRDT, once reading it back —
so the marks *looked* correctly placed as long as nobody edited. Only the stored
quote gave it away, by starting mid-word.

### Comments and suggestions live in the same Y.Doc as the text

Not in tables of their own. `doc_state.ydoc` already syncs, persists, merges and
backs up, so putting a `comments` and a `suggestions` `Y.Array` inside it meant
no server change, no second sync path, and a comment arriving in the same update
as the edit it refers to — never out of order.

Both anchor with `Y.RelativePosition`, so a mark stays on its words when someone
inserts text above it. Yjs does not invalidate a position whose text is deleted;
it collapses it toward a neighbour, so `to - from === 0` is the orphan signal.

**A suggestion's text is always really in the document** — an open insertion is
text that exists and is marked green, an open deletion is text that exists and is
marked red. That mirrors Word's "All Markup" view and is what keeps the textarea
and the CRDT in agreement, so export, search, pagination and word count all keep
working on a script with open suggestions in it. Resolving is then only ever
"keep the text" or "remove the text".

Two things about ranges that are not obvious and both caused bugs:

- **A range end leans.** A Yjs relative position binds to a character, and
  `assoc` picks which side. Insertions want to be greedy at both ends so
  continued typing extends one proposal; deletions want to be greedy at neither,
  or typing a replacement next to a deletion marks the replacement for deletion
  too.
- **A resolved suggestion's text must be frozen.** An accepted insertion stays in
  the document with its end still associating rightwards, so a live reading would
  swallow whatever is typed next; a removed one leaves nothing to read at all.
  The copy is frozen in the same transaction that records the outcome.

Resolved suggestions are kept, not deleted, so the thread explaining a change
outlives the decision. `Dismiss` is the only thing that removes one.

### Who wrote what: the present exactly, the past coarsely

Two different questions, and Yjs answers them at very different prices.

**The present.** Every character carries the clientID that inserted it, so
per-character authorship is already in the document. `blame.js` walks the item
list and turns it into stretches per person. A clientID is per *session*, so the
document carries a small `authors` map from clientID to person, written on a
browser's **first edit** — not on connect, which would add an entry every time
someone merely opened the script.

**The past.** `doc_versions.state_vector` records, per client, how many
operations each had produced at the moment of a snapshot; comparing consecutive
vectors names exactly who contributed in between. Coarse — "who worked on this
version", not "who wrote this sentence".

**Why not per-character attribution inside a diff**, which is the same question
asked of the past: Yjs answers it only with snapshots, and snapshots require the
document to be created with `gc: false`. That keeps every character anyone ever
deletes, forever, and cannot be undone for a document already in use. A state
vector is a few bytes per client and costs the document nothing.

Nothing invents a name. A client that never registered — a file import, or
anything written before this existed — reports as unattributed rather than being
guessed at.

### Inviting is an administrator's job; sharing is not

Sharing with an account that already exists is an ordinary thing an owner does.
Creating an invite is different in kind: on an install with no public
registration it mints a credential that becomes an account. So `users.is_admin`
gates `/api/invite` only, and the share dialog offers a list of people who
already have accounts. Promotion is a shell operation (`create-user.js --admin`),
not something reachable from the app.

`auth.js` holds the input rules in one place — addresses and names bounded to 50
characters, normalised, stripped of control characters including the
bidirectional overrides that let one display name render as another. Bounded
*first*: without a cap an 8 MB body reached password hashing before anything
rejected it.

**The address rule is deliberately loose** — one `@`, no whitespace, and nothing
more. A first version required a dot in the domain, which reads as obviously
correct and locked a real account (`joachim@eklund`) out of logging in. A login
validator runs against accounts that already exist, so rejecting one is not a
warning, it is a lockout.

### The phone gets a different rendering, not a smaller one

A screenplay page is a physical sheet, 85 characters wide. Fitting it across
375px means about 6px type: it fits, and nobody can read it. Below 760px the
sheet is dropped and the script runs as one continuous column at full size, with
the page boundary surviving as a rule and a number.

It is a **styling variant, not a second renderer** — same pagination, same DOM,
one body class. Rotating to landscape passes the breakpoint and brings the real
sheets back, which is the escape hatch when the layout itself is what is being
checked. Tablets keep the real page, scaled to fit its pane.

The same breakpoint drives the rest: the sidebar becomes an overlay drawer, and
split resolves to a single pane. Touch sizing is keyed on `pointer: coarse`
rather than width, because a 1024px tablet is a touch device and a 600px desktop
window is not.

### The toolbar spends its overflow into a menu

Every control carries a `data-prio`; when the bar runs out of room they move into
a `⋯` menu, highest number first. Measuring beats breakpoints — a long script
name, the cloud-only buttons appearing mid-session, or a wider translated label
all take care of themselves.

The rule the menu exists to keep is that **nothing disappears without somewhere
to reach it**, which is why a control that is not a button (the connection
status, the collaborator chips) still contributes a line, and why the panes are
pinned out of the menu on a phone.

### Installable, with the network still in charge

A manifest, an icon set and a service worker make the app installable on iOS,
Android and desktop. The worker caches **network-first**, which is not the usual
advice: a cache-first shell is faster, but it means a deploy does not reach
anyone until the worker updates — on an app under active change, a way to ship a
bug that cannot be recalled. `/api/` is never cached, because a stale answer
there would show a script as it used to be.

This is not a new offline mode. `backend.js` already falls back to IndexedDB when
no server answers; caching the shell is what makes that reachable from a home
screen icon with no connection.

### app.js is not modified

`cloud.js` wraps four globals from outside — `markDirty`, `applySmartUppercase`,
`openScript`, `histUndo`/`histRedo`. app.js is a classic script with no `use
strict`, so its top-level `function` declarations are window properties and
reassigning them affects its own internal calls too.

This is the same override idiom `backend.js` already uses for `window.fetch` and
the export button, so it matches the codebase rather than introducing a pattern.
The payoff: the local server and offline builds run byte-identical app.js, and
nothing in the cloud work can break them.

> Two traps in that approach, both handled in `cloud.js`. `const state` is a
> *lexical* global and never lands on `window` — it must be reached as a bare
> identifier. And `window.status` is the browser's own status-bar string, which
> app.js's `function status()` shadows; calling it via `window.status` is
> unreliable, so `cloud.js` has a guarded `notify()` helper.

### Node for the service, Python kept for typesetting

The VPS runbook is Node-shaped and Yjs is JavaScript-native, so the service is
Node. But `pdf_layout.py` drives ReportLab and `fdx.py` speaks Final Draft XML,
and every export entry point is already a pure function:

```
pdf_layout.build_pdf(text) -> bytes
pdf_layout.build_sides_pdf(text, character) -> bytes
pdf_layout.build_cue_sheet_pdf(text) -> bytes
fdx.build_fdx(text) -> bytes
fdx.fdx_to_fountain(xml) -> str
```

So `export-service/` is ~60 lines that import those modules **unchanged**. No
reimplementation in JavaScript, and no second copy to keep in sync.

Because it is stateless and bound to `127.0.0.1`, it skips almost all of the
add-service runbook — no DNS, no TLS, no database, no backups. It also takes no
file paths, so `safe_script_path` and its whole traversal surface never ship to
the server. Node authenticates and proxies to it.

### scrypt, not argon2

The plan said argon2. Ukeportalen already uses scrypt from Node's built-in
`crypto`, in a `scrypt$<salt>$<hash>` format. Matching it means one convention
across both services and **no native module to compile on the VPS** — argon2
needs node-gyp. scrypt is memory-hard and an accepted password KDF, so there is
no security cost.

One deliberate difference: `auth.js` uses the **async** `crypto.scrypt`, not
`scryptSync`. The same process serves collaboration WebSockets, and a
synchronous KDF would stall every connected editor for the duration of a login.

### Bearer token, not a cookie

The frontend is on `*.github.io` and the API on its own domain, so a session
cookie is a third-party cookie and is blocked by default in current browsers.
(Ukeportalen can use cookies because `ukeportalen.no` and `api.ukeportalen.no`
share a registrable domain. Faaglarna's domains now share one too —
`lektorensrud.no` — so cookies would in fact work, but the bearer token is kept:
it also works from the `*.github.io` origin, needs no credentialed CORS, and is
one less thing to get wrong.) A token in `localStorage` plus an `Authorization`
header sidesteps this, and means CORS needs no credentialed mode.

Tokens — sessions and invites alike — are stored only as SHA-256. A database
dump cannot be replayed as a live session or a usable invite.

### Hocuspocus on its own port

v4 moved off the `ws` package onto `crossws`, and `handleConnection()` now wants
a web-standard `Request` rather than Node's `IncomingMessage` — mounting it on
Express means hand-wiring the crossws Node adapter to the upgrade event. The
built-in `Server` class is documented as working exactly as before for Node, so
that runs on `:3003` in the same process (shared pool, shared auth) and nginx
routes `/collab/` to it.

Two API details cost a round of correction, both worth remembering:
`openDirectConnection` is on `Hocuspocus`, not `Server` (reach it via
`server.hocuspocus`), and the `onAuthenticate` payload carries
**`connectionConfig`**, not `connection`.

### The document name on the wire is the UUID

Never the path — paths change on rename, and a rename must not sever a live
session or split a document in two.

### Delete is a soft delete

`server.py` snapshots content before unlinking, so history outlives the file.
The cloud mirrors that: `documents.deleted_at` is set, and a partial unique index
(`WHERE deleted_at IS NULL`) lets a new document reuse the freed path.

## Data model

```
users        (id, email UNIQUE, name, password_hash, created_at, last_seen, is_admin)
invites      (token_hash PK, email, doc_id, doc_role, invited_by, expires_at, used_at, used_by)
sessions     (token_hash PK, user_id, created_at, expires_at)
documents    (id, owner_id, path, created_at, updated_at, deleted_at)
doc_access   (doc_id, user_id, role)      -- owner | editor | viewer
doc_state    (doc_id PK, ydoc BYTEA, updated_at)
doc_versions (id, doc_id, name, timestamp, content, author_id, created_at, state_vector)
```

Notes worth keeping in mind:

- **`documents.path` deliberately preserves path addressing** so `/api/tree`,
  `/api/file?path=`, rename and delete keep their existing contracts. Paths are
  unique **per owner**, not globally.
- **The owner also gets a `doc_access` row** (role `owner`), so every access
  check is one lookup with no special-casing.
- **`doc_versions.name`/`timestamp` carry server.py's snapshot naming**
  (`YYYYMMDDTHHMMSS[-N].fountain`) so `/api/history` returns shapes identical to
  the local server and the existing history UI needs no changes.
- **Email is stored lower-cased** by the caller so a plain `UNIQUE` suffices;
  `citext` would need `CREATE EXTENSION`, which the app user may not be allowed
  to run.
- **Documents shared with you appear under `Shared/<owner>/`**, which the tree
  renderer already supports as nested `type: 'dir'` entries. `Shared` is a
  reserved first path segment.
- **`users.is_admin`** gates `/api/invite` and nothing else. It is a property of
  the person, not of any document, because inviting is about who may exist here
  rather than who may read what.
- **`doc_versions.state_vector`** is what makes a version say who changed it.
  `author_id` only ever recorded who pressed Ctrl+S.
- **Comments, suggestions and the clientID→person `authors` map live INSIDE
  `doc_state.ydoc`**, not in tables. They are `Y.Array`s and a `Y.Map` in the
  same document as the text — see the decision above.

## What is verified, and what is not

All suites run with **no database server and no network**: `db.js` has a
`_setDriver` seam that swaps in PGlite, an in-process WASM PostgreSQL 18.

| Suite | Count | What it actually exercises |
|---|---|---|
| `tests/fountain/test_python.py` | 32 | the Fountain parser, plus character identity and which scene headings each format keeps — the last two also assert the JavaScript and Python ports agree, by running both over the same input |
| `server-node/test/smoke.js` | 66 (70 with the sidecar) | the real Express app on real Postgres: schema, auth, the whole access-control matrix, who may invite, the input rules, version attribution, history semantics, rename/delete, CRDT storage, and — with `EXPORT_SERVICE_URL` set — real PDF/FDX rendering and `.fdx` import |
| `server-node/test/collab.js` | 14 | the real Hocuspocus server over real WebSockets: auth rejection (no token / forged / no access / unknown doc), propagation between two clients, convergence of concurrent edits, server-enforced read-only, persistence, and reload after a restart |
| `collab/test-binding.mjs` | 11 | the diff (3000 fuzzed edits) and CRDT convergence, including same-offset concurrent inserts and per-user undo |
| `collab/test-twoclient.mjs` | 20 | two real clients through the real `collab.js`: `attach()`, the observer and `applyRemote()` writing to a textarea, plus suggestions crossing between them and CRLF documents |
| `collab/test-comments.mjs` | 16 | anchoring, orphan detection, threads, permissions, and two clients commenting and replying at once |
| `collab/test-suggestions.mjs` | 35 | that each kind of accept and reject leaves exactly the right text, including after an anchor shift, when orphaned, in bulk, and while correcting yourself mid-suggestion |

**A gap worth remembering.** For a while `test-binding.mjs` was the only binding
coverage, and it re-implements the sync by hand against raw `Y.Doc`s. That left
`attach()`, the `ytext` observer and `applyRemote()` — the path the app actually
runs — untested, which is exactly where the CRLF bug lived. Worse, the first
version of `test-twoclient.mjs` did not reproduce it either: its fake textarea
stored whatever it was given. A fake that does not normalise newlines is not a
textarea, and that difference *was* the bug. Fidelity in the fake was what
turned an unreproducible report into a failing test.

Independently checked: the export sidecar's output is **byte-identical** to
calling the library directly, and FDX round-trips losslessly across all 148 core
tokens of a real script. Sections and synopses do not survive, because `.fdx`
cannot represent them — `fdx.py` documents this, and it is pre-existing.

**Verified by hand in a browser, once deployed** (2026-08-28): live editing
between two accounts, presence, sharing by invite link, account creation from an
invite, view-only enforcement, per-user undo, password change with session
eviction, all four export formats, and version history.

That pass found **five bugs, every one of them in the layer with no automated
coverage** - which is where they were predicted to be:

1. **`app.js` loaded before `backend.js`.** app.js calls `loadTree()` at parse
   time, so the first `/api/tree` used the native fetch and bypassed the shim -
   no auth header (401 in cloud mode; a 404 in offline mode, which is why this
   pre-existing bug had gone unnoticed).
2. **`location /collab/` in nginx.** The Hocuspocus provider sends the document
   name in the protocol, not the path, and strips trailing slashes - so the
   browser connects to exactly `/collab`, which that block did not match.
3. **`location /collab` (the first fix) was a prefix match**, so it also
   swallowed `/collab.js`, proxying the frontend's own script to the WebSocket
   server. `location = /collab` is the correct form, and the config says why in
   both directions.
4. **Manual saves never reached the server**, so version history stayed empty -
   see the `/api/save` section above.
5. **A `joinDocument` race**: app.js reopens the last document from
   `loadTree().then(...)`, which can still be in flight when `load` fires.

**Still not verified:** undo when one person inserts a word inside a sentence
another wrote. Yjs tracks character origin independently so it should behave,
and the same-offset concurrent-insert case is covered by a test, but that exact
interleaving has not been tried.

## Deployment shape

Ports to claim in the runbook's registry: **3001** (REST), **3002** (Python
sidecar), **3003** (collaboration WebSocket).

The one genuine trap: **the generic nginx template in
`README-add-service.md` will break WebSockets.** It sets `proxy_http_version 1.1`
but not the `Upgrade`/`Connection` headers, and nginx's default
`proxy_read_timeout` of 60s drops idle editing sessions. `nginx-faaglarna.conf`
sets both — if collaboration connects and then dies after a minute of not
typing, that is why. This applies to any future WebSocket service on that box.

`pm2 restart` sends SIGTERM, which `server.js` handles by calling
`flushPendingStores()` before exiting; `kill_timeout` is raised to 10s for it.
Restarting mid-edit does not lose the last few seconds of anyone's typing.

## File map

| Path | Role |
|---|---|
| `server-node/server.js` | REST API — same `/api/*` contract as `server.py` |
| `server-node/db.js` | pool, schema in `init()`, the `_setDriver` test seam |
| `server-node/auth.js` | scrypt, sessions, invites, `roleFor` access checks |
| `server-node/docs.js` | Y.Doc ↔ text, persistence, version history |
| `server-node/collab.js` | Hocuspocus server, authoritative `readText`/`writeText` |
| `export-service/export_server.py` | stateless PDF/FDX sidecar |
| `static/config.js` | the one place the API domain is set |
| `static/cloud.js` | session, sharing UI, collaboration lifecycle, app.js wrappers |
| `static/collab.js` | the Y.Text ↔ textarea binding, and the LF invariant |
| `static/comments.js` | comment threads anchored to ranges |
| `static/suggestions.js` | tracked changes: propose, explain, accept, reject |
| `static/blame.js` | who wrote what, from the CRDT's own item list |
| `static/review.js` | the comments-and-suggestions modal |
| `static/sw.js`, `static/manifest.json` | what makes it installable, and openable offline |
| `static/vendor/collab-bundle.js` | generated + committed; keeps the frontend build-free |
| `collab/build.mjs` | regenerates that bundle |
| `scripts/make-icons.py` | redraws the app icon at the sizes a manifest needs |
| `server-node/deploy/patch-nginx-web.py` | edits the LIVE nginx config in place — never copy over it, certbot owns it |

Changed in the existing codebase: `static/backend.js` (three-way boot, URL
rewrite, auth header), `static/index.html` (script tags, the manifest and the
web-app meta), `static/style.css` (cloud mode, the responsive and reflow layers).

**`app.js` is no longer untouched.** It was, through the whole backend build, and
the features since have needed it: the overflow menu, the source measure, the
mobile layout rules, character identity, and the beat board. `server.py`,
`fountain.py`, `fdx.py` and `pdf_layout.py` are still untouched by cloud mode;
`pagination.py` changed only in lockstep with `pagination.js`.

## Open items

- **Backups are local-only.** `/var/backups` and `/var/lib/postgresql` are the
  same filesystem, so the nightly dump survives a bad migration but not a lost
  VM - and `doc_state.ydoc` is the only copy of every script. An rclone push to
  personal OneDrive was built and rolled back: its token is drive-wide and
  Microsoft's scopes cannot be confined to one folder. See
  `../server-node/deploy/README-deploy.md` section 10b; object storage with a
  per-bucket write-only key is the answer that actually restricts access.
- **The Yjs bundle is committed, not built in CI.** That keeps
  `python server.py` working with no npm, but it must be regenerated by hand
  (`cd collab && npm run build`) whenever the pinned versions move.
- **`backup-ukeportalen.sh` has the same `cd /` bug** fixed here: run by hand
  from an admin shell, its `find` prune fails because postgres cannot read
  `/home/admin`. Harmless under cron, which runs from postgres's own home.
- **The VPS has no working IPv6.** Nothing depends on it, but an AAAA record for
  any service on that box would break IPv6-capable clients.

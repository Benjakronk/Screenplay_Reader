# TODO — cloud backend

**Done, 28 August 2026.** The backend is deployed and every item that was on
this list has been completed and verified in a browser.

| | |
|---|---|
| Frontend | `https://faaglarna.lektorensrud.no` — served from the VPS |
| API + collaboration | same origin: `/api/`, `/collab` |
| Database | PostgreSQL `faaglarna`, 7 tables |
| Exports | Python sidecar on `127.0.0.1:3002` |
| TLS | Let's Encrypt, auto-renewing |
| Backups | nightly `pg_dump` at 02:40, verified running |

Verified by hand: live editing between two accounts, presence, sharing by invite
link, account creation from an invite, view-only enforcement, per-user undo,
password change with session eviction, all four export formats, and version
history.

To rebuild any of it, see
[`../server-node/deploy/README-deploy.md`](../server-node/deploy/README-deploy.md).
For why it is shaped this way — and the five browser bugs that first deployment
turned up — see [`cloud-architecture.md`](cloud-architecture.md) or
[`cloud-architecture.html`](cloud-architecture.html).

---

## What is actually left

Nothing blocking. These are the known gaps, recorded so they are not rediscovered
as surprises.

- [ ] **`.gitignore`d scripts arrive with CRLF.** `core.autocrlf` is on in this
      repo's working copy, so `scripts/Åsta.fountain` is CRLF on disk. That is
      how the cloud copy got CRLF and became uneditable — see the LF invariant in
      `cloud-architecture.md`. The server now normalises on the way in, so this
      is defused rather than fixed; a `.gitattributes` marking `*.fountain` as
      `text eol=lf` would stop it at the source.
- [ ] **The preview pane does not mark suggestions.** The editor overlay and the
      sidebar panel do, which is enough to review and resolve them. Struck-through
      text in the rendered view is further work in the render pipeline.

- [ ] **Off-site backups.** `/var/backups` and `/var/lib/postgresql` are the same
      filesystem, so the nightly dump survives a bad migration but not a lost VM
      — and `doc_state.ydoc` is the only copy of every script. An rclone push to
      personal OneDrive was built and rolled back, because its token is
      drive-wide and Microsoft's OAuth scopes cannot be confined to one folder.
      Object storage with a per-bucket, **write-only** key is the answer that
      actually restricts access. See `README-deploy.md` §10b.
- [ ] **Test undo across an interleaved edit** — one person inserting a word
      inside a sentence another wrote. Yjs tracks character origin independently
      so it should behave, and the same-offset case is covered by a test, but
      that interleaving has not been tried.
- [ ] **`backup-ukeportalen.sh` has the same `cd /` bug** that was fixed here:
      run by hand from an admin shell its `find` prune fails, because postgres
      cannot read `/home/admin`. Harmless under cron, which runs from postgres's
      own home — but it will look like a failed backup if you ever test it.
- [x] **gzip now covers JavaScript.** `gzip_types` listed only
      `application/javascript` while nginx labels `.js` as `text/javascript`, so
      every script went out uncompressed. Fixed 30 August by
      `deploy/patch-nginx-web.py`: the Yjs bundle is 122 kB → 43 kB and `app.js`
      210 kB → 75 kB.
- [ ] **The VPS has no working IPv6.** Nothing depends on it, but an AAAA record
      for any service on that box would break IPv6-capable clients.
- [ ] **A push no longer deploys the frontend.** `git pull` on the box does.
      A cron or a webhook would close the gap if it becomes tiresome.
- [ ] **Dragging to reorder does not work on touch.** The beat board and the
      outline both reorder scenes with HTML5 drag-and-drop, which does not fire
      for touch events. Both are readable on a phone; neither can be reordered
      there. Needs a pointer-event drag implementation.
- [ ] **The nginx config in `deploy/` is not what is on the box.** Certbot
      rewrote the live file when it issued the certificate, so it holds the TLS
      block and the committed one does not. Copying it over would silently drop
      HTTPS — `nginx -t` passes, because an HTTP-only server is valid. Use
      `deploy/patch-nginx-web.py`, which edits in place.
- [ ] **Nobody but the owner is an administrator.** `benjamin@lektorensrud.no`
      was promoted by hand; anyone else who should be able to invite needs
      `node create-user.js <email> --admin` on the box.
- [ ] **Åsta's earliest text is unattributed.** Blame shows about 96% as
      "Imported from file" — the restore of 29 August — and the rest as
      unattributed browser sessions that predate the clientID→person registry.
      Everything written since is attributed; this resolves itself as the script
      is worked on.

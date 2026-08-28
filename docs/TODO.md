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
- [ ] **gzip does not cover the Yjs bundle.** `gzip_types` lists
      `application/javascript`, but nginx labels `.js` as `text/javascript`, so
      the 122 kB bundle is served uncompressed. Adding `text/javascript` would
      take it to roughly 35 kB.
- [ ] **The VPS has no working IPv6.** Nothing depends on it, but an AAAA record
      for any service on that box would break IPv6-capable clients.
- [ ] **A push no longer deploys the frontend.** `git pull` on the box does.
      A cron or a webhook would close the gap if it becomes tiresome.

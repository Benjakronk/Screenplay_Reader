# Deploy – Faaglarna cloud backend (Netcup VPS)

Two services on the VPS that already runs `api.ukeportalen.no`:

| Service | Port | What it is | Public? |
|---|---|---|---|
| `faaglarna-api` | **3001** (REST) + **3003** (WebSocket) | Node 22 + Express + PostgreSQL + Hocuspocus. Accounts, documents, live collaboration. | via nginx |
| `faaglarna-export` | **3002** | Python + ReportLab. Stateless PDF/FDX rendering. | **no** – localhost only |

This follows `../../../Skoleverktøy/ukeportalen/ukeplan-server/deploy/README-add-service.md`;
everything below is that runbook with the placeholders filled in, plus the parts
that differ. The base setup (admin user, SSH keys, ufw 22/80/443, Node 22, pm2,
nginx, PostgreSQL 17) is shared and already done.

**Claim these ports in that runbook's port registry table before you start:**
3001, 3002, 3003. Check each is free first:

```bash
for p in 3001 3002 3003; do echo -n "$p: "; sudo ss -ltnp | grep -c ":$p" ; done   # all 0
```

## 0. Domains

`api-faaglarna.lektorensrud.no` is the only thing this repo does not decide for you — e.g.
`api.faaglarna.no`. It must be a name you control in Domeneshop.

## 1. DNS first (certbot depends on it)

Add an **A record** for `api-faaglarna.lektorensrud.no` pointing at the same VPS IPv4 as
`api.ukeportalen.no`. Lower the TTL to 300s beforehand. Verify before continuing:

```bash
dig +short api-faaglarna.lektorensrud.no        # must print the VPS IPv4  (nslookup on Windows)
```

## 2. Database

```bash
sudo -u postgres psql <<'SQL'
CREATE DATABASE faaglarna;
CREATE USER faaglarna_app WITH PASSWORD 'CHANGE-ME-strong-password';
GRANT ALL PRIVILEGES ON DATABASE faaglarna TO faaglarna_app;
SQL
sudo -u postgres psql -d faaglarna -c "GRANT ALL ON SCHEMA public TO faaglarna_app;"
```

The `GRANT ALL ON SCHEMA public` is required on Postgres 15+ or `init()` cannot
create tables. There is no migration step: `db.js`'s `init()` runs on every boot
and is idempotent.

## 3. Copy the code up

```bash
# on the server
sudo mkdir -p /srv/faaglarna-api /srv/faaglarna-export
sudo chown "$USER" /srv/faaglarna-api /srv/faaglarna-export
```

```powershell
# on your laptop, from the repo root
scp -r server-node/server.js server-node/db.js server-node/auth.js `
       server-node/docs.js server-node/collab.js server-node/create-user.js `
       server-node/package.json server-node/package-lock.json `
       server-node/.env.example server-node/deploy `
       admin@api-faaglarna.lektorensrud.no:/srv/faaglarna-api/

# the export sidecar needs its own file plus the four Fountain modules from the
# repo root — they are imported unchanged, never duplicated
scp export-service/export_server.py export-service/requirements.txt `
       fountain.py fdx.py pdf_layout.py pagination.py `
       admin@api-faaglarna.lektorensrud.no:/srv/faaglarna-export/
scp -r export-service/deploy admin@api-faaglarna.lektorensrud.no:/srv/faaglarna-export/
```

`.env` is never in the copy list, so a redeploy never overwrites your secrets.

## 4. Install dependencies

```bash
cd /srv/faaglarna-api && npm ci --omit=dev

cd /srv/faaglarna-export
sudo apt install -y python3.13-venv     # match your python3 -V; REQUIRED
python3 -m venv venv
./venv/bin/pip install -r requirements.txt   # ReportLab, the only dependency
```

## 5. Secrets

```bash
cd /srv/faaglarna-api
cp .env.example .env
nano .env      # set PGPASSWORD, and ALLOWED_ORIGINS to where the frontend is
```

`ALLOWED_ORIGINS` is where the browser app is published. Any `*.github.io`
origin and any localhost port are allowed automatically, so you only need this
if you use a custom domain for the frontend.

The export sidecar has no `.env`: it holds no secrets and reaches no database.

## 6. Start both under pm2

```bash
cd /srv/faaglarna-export && pm2 start deploy/ecosystem.config.cjs
curl -s http://127.0.0.1:3002/health          # -> {"ok": true}

cd /srv/faaglarna-api && pm2 start deploy/ecosystem.config.cjs
pm2 logs faaglarna-api --lines 20 --nostream
#   faaglarna-collab listening on ws://127.0.0.1:3003
#   faaglarna-api    listening on http://127.0.0.1:3001
curl -s http://127.0.0.1:3001/api/health              # -> {"ok":true}
curl -s http://127.0.0.1:3001/api/ready               # -> {"ready":true}

pm2 save
```

`pm2 startup` is machine-wide and was done once already – do not repeat it.

## 7. nginx + TLS

```bash
sudo cp deploy/nginx-faaglarna.conf /etc/nginx/sites-available/api-faaglarna.lektorensrud.no
sudo ln -s /etc/nginx/sites-available/api-faaglarna.lektorensrud.no /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api-faaglarna.lektorensrud.no
```

> **This config is NOT the generic template.** A WebSocket needs the
> `Upgrade`/`Connection` headers to survive the proxy hop, and nginx's default
> `proxy_read_timeout` of 60s would silently drop an idle editing session. The
> `/collab/` block in `nginx-faaglarna.conf` sets both. If collaboration
> connects and then dies after a minute of not typing, this is why.

Verify from outside:

```bash
curl -s https://api-faaglarna.lektorensrud.no/api/health
```

## 8. Create the first account

There is no public registration – that is deliberate. Bootstrap yourself from
the command line, then invite everyone else from inside the app.

```bash
cd /srv/faaglarna-api
node create-user.js you@example.no 'a-long-password' 'Your Name'
```

Re-running it for an existing address resets that password; there is no email
flow, so this is also the password-reset path.

## 9. Point the frontend at it

In `static/config.js`:

```js
window.FAAGLARNA_CLOUD = 'https://api-faaglarna.lektorensrud.no';
```

Commit and push; GitHub Pages redeploys. Leaving it empty disables cloud mode
entirely and the app behaves exactly as it did before — which is also the
instant rollback if anything misbehaves.

## 10. Backups

The nightly cron only dumps `ukeportalen`. Add `faaglarna` to it (per
README-add-service.md §8), then **test by hand before trusting cron**:

```bash
sudo mkdir -p /var/backups/faaglarna
sudo chown postgres:postgres /var/backups/faaglarna
sudo -u postgres /usr/local/bin/backup-ukeportalen.sh
ls -lh /var/backups/faaglarna        # a .sql.gz must appear
```

`doc_state.ydoc` is `BYTEA`, which `pg_dump` handles fine. Restore-test the
first dump into a scratch database so you know the rollback works.

## 9b. Serving the frontend from this VPS (instead of GitHub Pages)

The frontend was originally on GitHub Pages. It is now served from this box, on
the **same origin** as the API:

```
https://faaglarna.lektorensrud.no/          -> /srv/faaglarna-web/static
https://faaglarna.lektorensrud.no/api/      -> Node 127.0.0.1:3001
https://faaglarna.lektorensrud.no/collab/   -> Hocuspocus 127.0.0.1:3003
```

One origin means there is no cross-origin request at all - no preflights, no
`ALLOWED_ORIGINS` to keep in step with the frontend's address, and no way to get
CORS subtly wrong. `backend.js` still resolves correctly: its probe of
`/api/tree` returns 401 (not `ok`), so it falls through to the cloud branch,
which then talks to its own origin.

### DNS

Replace the CNAME with an A record - a name cannot have both:

| Type | Host | Value |
|---|---|---|
| ~~CNAME~~ | ~~`faaglarna`~~ | ~~`benjakronk.github.io.`~~ **delete** |
| `A` | `faaglarna` | the VPS IPv4 |

Then clear the custom domain in the repo's **Settings -> Pages**, so GitHub stops
claiming a name that no longer points at it.

### Deploy

The repository is public, so the box pulls it directly - no scp, and the
deployed commit is always identifiable:

```bash
sudo mkdir -p /srv/faaglarna-web
sudo chown "$USER" /srv/faaglarna-web
git clone https://github.com/Benjakronk/Screenplay_Reader.git /srv/faaglarna-web
```

Updating the frontend afterwards is one command:

```bash
cd /srv/faaglarna-web && git pull
```

No restart or reload needed - nginx serves the files from disk.

### nginx + TLS

```bash
sudo cp /srv/faaglarna-api/deploy/nginx-faaglarna-web.conf         /etc/nginx/sites-available/faaglarna.lektorensrud.no
sudo ln -s /etc/nginx/sites-available/faaglarna.lektorensrud.no            /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d faaglarna.lektorensrud.no
```

`api-faaglarna.lektorensrud.no` keeps working as before. Keeping it costs
nothing and leaves the API reachable on its own name.

## 10b. Off-site copy of the backups - NOT set up, deliberately

`/var/backups` and `/var/lib/postgresql` are the same filesystem, so the nightly
dumps survive a bad migration but not a lost VM. For Faaglarna that gap is real:
`doc_state.ydoc` is the **only** copy of every script.

An rclone push to personal OneDrive was built and then **rolled back**. The
reason is worth recording, because the pull to just redo it will be strong:

> rclone's OneDrive token is **drive-wide**. Microsoft's OAuth scopes work at
> the drive level, so there is no way to confine it to one folder -
> `Files.ReadWrite.AppFolder`, the nearest thing, confines an app to
> `/Apps/<name>`, a directory Microsoft chooses. An `alias` remote bounds
> accidents but is not a security boundary: the full-drive token still sits in
> `~/.config/rclone/rclone.conf`, and anyone with root on this VPS has the whole
> personal drive. Trading that exposure for a few KB of nightly dumps is a bad
> deal.

If you want off-site copies, use a destination that supports **scoped
credentials** instead - object storage with a per-bucket, write-only key, so a
compromised VPS can add backups but cannot read or delete existing ones.
Backblaze B2, Cloudflare R2 and Hetzner all do this, rclone speaks S3 natively,
and a few KB a night costs approximately nothing.

Until then the dumps are local-only. That is a known, accepted gap - not an
oversight.

## 11. Monitoring

UptimeRobot keyword monitor on `https://api-faaglarna.lektorensrud.no/api/ready`, alerting when the
body does not contain `ready`. That endpoint runs a real query, so a 200 means
Postgres is genuinely reachable.

The export sidecar has no external monitor: it is stateless and localhost-only,
and if it dies exports return 503 while everything else keeps working. `pm2
status` shows it.

## Updating later

```powershell
scp server-node/server.js server-node/db.js ... admin@api-faaglarna.lektorensrud.no:/srv/faaglarna-api/
```
```bash
cd /srv/faaglarna-api
npm ci --omit=dev            # only if package.json changed
pm2 restart faaglarna-api
```

`pm2 restart` sends SIGTERM, which `server.js` handles by flushing pending CRDT
writes before exiting (`kill_timeout` is raised to 10s for this). Restarting
mid-edit does not lose the last few seconds of anyone's typing.

## Schema changes

Same rules as the Ukeportalen API. `init()` re-runs on every boot, so an
**additive** change is one idempotent line:

```js
await query("ALTER TABLE documents ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';");
```

Editing an existing `CREATE TABLE` block does nothing to a live table. Anything
destructive (rename, drop, type change, backfill) is **not** safely idempotent —
back up, run it by hand in `psql`, verify, and do not put it in `init()`.

## Tests

Both suites run with no database server and no network:

```bash
cd server-node && npm test          # 42 API tests + 12 collaboration tests
cd collab      && npm test          # the Y.Text <-> textarea binding
```

They use PGlite (an in-process WASM Postgres) and real WebSocket connections, so
the schema, access control and CRDT paths are exercised as deployed. Add
`EXPORT_SERVICE_URL=http://127.0.0.1:3002` with the sidecar running to also
cover real PDF/FDX rendering.

## Removing it

```bash
pm2 delete faaglarna-api faaglarna-export && pm2 save
sudo rm /etc/nginx/sites-enabled/api-faaglarna.lektorensrud.no /etc/nginx/sites-available/api-faaglarna.lektorensrud.no
sudo nginx -t && sudo systemctl reload nginx
sudo certbot delete --cert-name api-faaglarna.lektorensrud.no
# after a final backup: sudo -u postgres dropdb faaglarna
```

Free ports 3001/3002/3003 in the registry and remove the DNS A-record.

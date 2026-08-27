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

## 10b. Off-site copy of the backups (rclone -> OneDrive)

`/var/backups` and `/var/lib/postgresql` are the same filesystem, so the nightly
dumps survive a bad migration but not a lost VM. For Faaglarna that gap matters
more than for Ukeportalen: `doc_state.ydoc` is the **only** copy of every script.

> **Do not use `apt install rclone`.** Ubuntu ships a 2022-era build (v1.60.1)
> that fails against Microsoft's current OneDrive upload API with
> `unauthenticated: Unauthenticated` - while `lsd`, `about` and even `mkdir`
> keep working, so it looks like an auth problem rather than a stale binary.
> Use rclone's own installer:

```bash
curl https://rclone.org/install.sh | sudo bash
rclone version        # v1.75.0 or newer
```

Then authorise a remote **as `admin`, not root or postgres** - rclone stores its
config in the running user's home, and the cron entry runs as `admin`.

The VPS has no browser, so forward rclone's OAuth callback port from your
laptop and let your own browser do the login:

```bash
# from your laptop - keep this session open while configuring
ssh -L 53682:localhost:53682 admin@api-faaglarna.lektorensrud.no
```

In that session run `rclone config` and answer:

| Prompt | Answer |
|---|---|
| `n) New remote` | `n` |
| `name>` | `onedrive-personal` |
| `Storage>` | `onedrive` (Microsoft OneDrive) |
| `client_id>` / `client_secret>` | blank |
| `region>` | `1` (global) |
| `Edit advanced config?` | `n` |
| `Use web browser to automatically authenticate?` | `y` - the port-forward makes this work |
| `Type of connection>` | `onedrive` (Personal or Business) |
| drive list | pick the **personal** drive |

> **Sign in with the personal Microsoft account, not the work one.** Your browser
> is probably already signed into the DGI account, and rclone will silently take
> whichever it is handed. Use a private window for the login step.

Confirm which account you actually got before trusting it:

```bash
rclone about onedrive-personal:
rclone lsd  onedrive-personal:
```

Then create an `alias` remote scoped to the backup subtree, and point the script
at that rather than at the full drive:

```bash
rclone config create onedrive-backups alias     remote onedrive-personal:Backups/faaglarna-vps
```

This bounds what a bug or a typo in the script can reach. It is **not** a
security boundary - the full-drive remote is still in the same config file, and
the OAuth token it holds is drive-wide. Microsoft's scopes are drive-level, so
confining a token to one chosen folder is not possible; the nearest thing,
`Files.ReadWrite.AppFolder`, confines an app to `/Apps/<name>`, a folder
Microsoft picks. If that matters, push to object storage with a scoped
write-only key instead of to personal OneDrive.

Install the push script and test it:

```bash
sudo cp /srv/faaglarna-api/deploy/offsite-backup.sh /usr/local/bin/offsite-backup.sh
sudo chmod +x /usr/local/bin/offsite-backup.sh

/usr/local/bin/offsite-backup.sh --dry-run     # read what it says it would do
/usr/local/bin/offsite-backup.sh
rclone ls onedrive-personal:Backups/faaglarna-vps/faaglarna
```

Schedule it as `admin` (**not** postgres - that user has no home for the config):

```bash
crontab -e
# 03:10, after the 02:40 dump has finished:
10 3 * * * /usr/local/bin/offsite-backup.sh >> /home/admin/offsite-backup.log 2>&1
```

Two deliberate choices in that script:

- **`rclone copy`, not `sync`.** `sync` would mirror the local 30-day pruning to
  OneDrive and delete the older copies, which defeats the point. Remote
  retention is handled separately, at 90 days.
- **It fails loudly if the remote is unreachable.** An expired OAuth token would
  otherwise mean months of silently copying nothing.

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

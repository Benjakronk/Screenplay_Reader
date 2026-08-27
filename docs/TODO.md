# TODO — get the cloud backend running

Everything is written, tested and merged. What is left is provisioning. Full
commands in [`../server-node/deploy/README-deploy.md`](../server-node/deploy/README-deploy.md);
this is the running order with a checkbox per step.

**Domains are decided and already baked into the config files:**

| | |
|---|---|
| Frontend | `faaglarna.lektorensrud.no` → GitHub Pages |
| API + collaboration | `api-faaglarna.lektorensrud.no` → the VPS |

Fill in the two things that are still blank:

```
<DBPASS>      = ______________________   (generate a long one)
<ADMIN_EMAIL> = ______________________   (your login)
```

Ports to claim in the registry table in `README-add-service.md`:
**3001** REST · **3002** Python export sidecar · **3003** collaboration WebSocket.

---

## 1. DNS — both records, do this first

In the Domeneshop panel for `lektorensrud.no`. Lower the zone TTL to 300s first.

- [ ] **API** — an **A record**:
      `api-faaglarna` → the VPS IPv4 (same box as `api.ukeportalen.no`)
- [ ] **Frontend** — a **CNAME record**:
      `faaglarna` → `benjakronk.github.io.` (with the trailing dot)

> A subdomain pointed at GitHub Pages takes a **CNAME**, not an A record. A
> records to GitHub's IPs are only for apex domains, which this is not.

- [ ] Verify both before going further:

```bash
dig +short api-faaglarna.lektorensrud.no    # -> the VPS IPv4
dig +short faaglarna.lektorensrud.no        # -> benjakronk.github.io, then GitHub IPs
```

> **Do not run certbot (step 9) until the first one returns the right IP.** The
> HTTP-01 challenge fails otherwise, and that is the most common way this whole
> process goes wrong.

## 2. Frontend custom domain

Independent of the VPS — can be done while DNS propagates.

- [ ] Repo **Settings → Pages → Custom domain** → `faaglarna.lektorensrud.no` → Save.
- [ ] Wait for the DNS check to go green, then tick **Enforce HTTPS**.
- [ ] Confirm the app loads at `https://faaglarna.lektorensrud.no`.

> **No `CNAME` file is needed.** This repo publishes with `actions/deploy-pages`,
> and that workflow ignores any `CNAME` file in the artifact — the domain lives in
> the Pages settings and persists across deploys. Do not add one; it would do
> nothing and mislead the next person.
>
> Setting the custom domain before DNS resolves makes the site briefly
> unreachable, so do step 1 first.

A nice side effect: on the custom domain the app is served from `/`, not from
`/Screenplay_Reader/`.

## 3. Check the ports are free

- [ ] On the server:

```bash
for p in 3001 3002 3003; do echo -n "$p: "; sudo ss -ltnp | grep -c ":$p"; done
# all three must print 0
```

- [ ] Add all three to the port registry table in `README-add-service.md`.

## 4. Database

- [ ] Create it:

```bash
sudo -u postgres psql <<'SQL'
CREATE DATABASE faaglarna;
CREATE USER faaglarna_app WITH PASSWORD '<DBPASS>';
GRANT ALL PRIVILEGES ON DATABASE faaglarna TO faaglarna_app;
SQL
sudo -u postgres psql -d faaglarna -c "GRANT ALL ON SCHEMA public TO faaglarna_app;"
```

> That last `GRANT ALL ON SCHEMA public` is **required** on Postgres 15+. Without
> it the app user cannot create tables even though it owns the database, and the
> service crash-loops on boot with a permissions error.

No migration step — `db.js`'s `init()` builds the schema on first boot and is
safe to re-run.

## 5. Copy the code up

- [ ] On the server:

```bash
sudo mkdir -p /srv/faaglarna-api /srv/faaglarna-export
sudo chown "$USER" /srv/faaglarna-api /srv/faaglarna-export
```

- [ ] From the repo root on your laptop (PowerShell):

```powershell
scp -r server-node/server.js server-node/db.js server-node/auth.js `
       server-node/docs.js server-node/collab.js server-node/create-user.js `
       server-node/package.json server-node/package-lock.json `
       server-node/.env.example server-node/deploy `
       admin@api-faaglarna.lektorensrud.no:/srv/faaglarna-api/

scp export-service/export_server.py export-service/requirements.txt `
       fountain.py fdx.py pdf_layout.py pagination.py `
       admin@api-faaglarna.lektorensrud.no:/srv/faaglarna-export/
scp -r export-service/deploy admin@api-faaglarna.lektorensrud.no:/srv/faaglarna-export/
```

> The sidecar needs those four `.py` files from the **repo root** — it imports
> them unchanged rather than carrying its own copy. Forgetting them is an
> `ImportError` on first start.

## 6. Install dependencies

- [ ] API: `cd /srv/faaglarna-api && npm ci --omit=dev`
- [ ] Sidecar:

```bash
cd /srv/faaglarna-export
sudo apt install -y python3-venv        # usually already there
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

## 7. Secrets

- [ ] `cd /srv/faaglarna-api && cp .env.example .env`
- [ ] Set `PGPASSWORD=<DBPASS>`.
- [ ] Confirm `ALLOWED_ORIGINS=https://faaglarna.lektorensrud.no` is present.

> **This one will bite if it is wrong.** The API auto-allows any `*.github.io`
> origin and any localhost port, but `faaglarna.lektorensrud.no` is a custom
> domain and matches neither rule — it has to be listed explicitly.
>
> Symptom: the app loads fine, then every request fails with a CORS error in the
> console and nothing else explains why. `.env.example` already has the right
> value, so this is really just "don't delete it".

The sidecar has no `.env` — it holds no secrets and reaches no database.

## 8. Start both under pm2

- [ ] Sidecar first, so exports work from the start:

```bash
cd /srv/faaglarna-export && pm2 start deploy/ecosystem.config.cjs
curl -s -X POST http://127.0.0.1:3002/health        # -> {"ok": true}
```

- [ ] Then the API:

```bash
cd /srv/faaglarna-api && pm2 start deploy/ecosystem.config.cjs
pm2 logs faaglarna-api --lines 20 --nostream
#   expect BOTH:
#     faaglarna-collab listening on ws://127.0.0.1:3003
#     faaglarna-api    listening on http://127.0.0.1:3001
curl -s http://127.0.0.1:3001/api/health            # -> {"ok":true}
curl -s http://127.0.0.1:3001/api/ready             # -> {"ready":true}
```

- [ ] `pm2 save`

> `/api/ready` is the one that matters — it runs a real query, so it proves
> Postgres is reachable. `/api/health` always answers 200.
>
> Do **not** run `pm2 startup` again; it is machine-wide and was done once
> already for ukeportalen.

## 9. nginx + TLS

- [ ] Install the config — **ours, not the generic template**:

```bash
cd /srv/faaglarna-api
sudo cp deploy/nginx-faaglarna.conf \
        /etc/nginx/sites-available/api-faaglarna.lektorensrud.no
sudo ln -s /etc/nginx/sites-available/api-faaglarna.lektorensrud.no \
           /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api-faaglarna.lektorensrud.no
```

The `server_name` is already correct in the file — no editing needed.

- [ ] Verify from outside the box:

```bash
curl -s https://api-faaglarna.lektorensrud.no/api/health
```

> **The generic template in `README-add-service.md` breaks WebSockets.** It sets
> `proxy_http_version 1.1` but not the `Upgrade`/`Connection` headers, and
> nginx's default `proxy_read_timeout` of 60s drops idle editing sessions.
> `nginx-faaglarna.conf` sets both.
>
> Symptom if this is wrong: collaboration connects fine, then dies after about a
> minute of not typing.

## 10. Create your account

- [ ] No public registration, so bootstrap yourself:

```bash
cd /srv/faaglarna-api
node create-user.js <ADMIN_EMAIL> 'a-long-password' 'Your Name'
```

Re-running this for an existing address resets the password — that is also the
password-reset path, since there is no email flow.

## 11. Turn cloud mode on

- [ ] In `static/config.js`, change the last line to:

```js
window.FAAGLARNA_CLOUD = 'https://api-faaglarna.lektorensrud.no';
```

- [ ] Commit and push. Pages redeploys and the sign-in prompt appears.

Setting it back to `''` is the instant rollback — no server change needed.

> Left empty until now on purpose: the moment it is set, the app offers a
> sign-in prompt on every visit, which is just noise while there is nothing
> behind it.

## 12. First real sign-in — expect to find bugs here

- [ ] Sign in at `https://faaglarna.lektorensrud.no`.
- [ ] Create a script, type in it, reload, confirm the text survived.
- [ ] Open the same script in a private window as a second account, type in both,
      confirm the text merges and neither caret jumps.
- [ ] Export a PDF and an `.fdx` from the hosted app.
- [ ] Share a script, accept the invite link, confirm it appears under `Shared/`.
- [ ] Set that collaborator to viewer, confirm they cannot type.

> **This is the least-tested part of the whole build.** The server is covered end
> to end (54 automated tests), but the browser UI — sign-in dialog, presence
> chips, share dialog, and the wrapping of app.js's globals — has no automated
> coverage. Budget an hour for whatever this turns up.

## 13. Operations — the part that saves you later

- [ ] Add `faaglarna` to the nightly `pg_dump` (per `README-add-service.md` §8):

```bash
sudo mkdir -p /var/backups/faaglarna
sudo chown postgres:postgres /var/backups/faaglarna
sudo -u postgres /usr/local/bin/backup-ukeportalen.sh
ls -lh /var/backups/faaglarna      # a .sql.gz must appear before you trust cron
```

- [ ] Restore-test that first dump into a scratch database, so you know the
      rollback works before you need it.
- [ ] UptimeRobot keyword monitor on
      `https://api-faaglarna.lektorensrud.no/api/ready`, alerting when the body
      does **not** contain `ready`.

---

## If something breaks

| Symptom | Likely cause |
|---|---|
| certbot fails the challenge | DNS not propagated — re-check `dig +short api-faaglarna.lektorensrud.no` |
| Pages says the domain is not properly configured | The `faaglarna` record must be a **CNAME** to `benjakronk.github.io.`, not an A record |
| App loads, but every request fails with CORS | `ALLOWED_ORIGINS` missing `https://faaglarna.lektorensrud.no` |
| Service crash-loops on boot | Missing `GRANT ALL ON SCHEMA public`, or a wrong `PGPASSWORD` in `.env` |
| `pm2 status` shows climbing restarts | Boot-time crash — read the logs *before* restarting again |
| Collaboration connects then dies after ~1 min | nginx missing `Upgrade`/`Connection` or the long `proxy_read_timeout` |
| Exports return 503 | Sidecar down (`pm2 status`), or `EXPORT_SERVICE_URL` unset in `.env` |
| A port silently collides | `sudo ss -ltnp \| grep ':300'` — pm2 shows the loser crash-looping |

Triage always starts the same way:

```bash
pm2 status
pm2 logs faaglarna-api --lines 50 --nostream
curl -s -o /dev/null -w '%{http_code}\n' https://api-faaglarna.lektorensrud.no/api/ready
```

---

## Later, not now

- The Yjs bundle is committed rather than built in CI. Regenerate by hand
  (`cd collab && npm run build`) whenever the pinned versions move.
- Remote carets inside the editor would mean moving to CodeMirror 6 — the server
  side needs no changes for it. See
  [`cloud-architecture.md`](cloud-architecture.md) for why the textarea stayed.
- `docs/cloud-architecture.md` and `.html` are parallel documents; a change to
  the architecture needs applying to both.
- The naming pattern generalises: `<project>.lektorensrud.no` and
  `api-<project>.lektorensrud.no`. Keeping the API at one level under the apex
  means a future wildcard certificate for `*.lektorensrud.no` would cover it.

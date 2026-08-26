# TODO — get the cloud backend running

Everything is written, tested and merged (`bba7899` on `main`). What is left is
provisioning. Full commands in
[`../server-node/deploy/README-deploy.md`](../server-node/deploy/README-deploy.md);
this is the running order with a checkbox per step.

**Only step 0 needs a decision. The rest follows mechanically.**

Fill these in once and reuse them below:

```
<DOMAIN>      = ______________________   (e.g. api.faaglarna.no)
<DBPASS>      = ______________________   (generate a long one)
<ADMIN_EMAIL> = ______________________   (your login)
```

Ports to claim in the registry table in `README-add-service.md`:
**3001** REST · **3002** Python export sidecar · **3003** collaboration WebSocket.

---

## 0. Pick a domain  ← the only blocking decision

- [ ] Choose `<DOMAIN>` — a name you control in Domeneshop.

## 1. DNS (do this first, then go do something else)

- [ ] Lower the TTL on the zone to 300s.
- [ ] Add an **A record** for `<DOMAIN>` → the same VPS IPv4 as `api.ukeportalen.no`.
- [ ] Wait for it, then verify:

```bash
dig +short <DOMAIN>          # must print the VPS IPv4   (nslookup on Windows)
```

> **Do not run certbot until this returns the right IP.** The HTTP-01 challenge
> fails otherwise, and that is the most common way this whole process goes wrong.

## 2. Check the ports are free

- [ ] On the server:

```bash
for p in 3001 3002 3003; do echo -n "$p: "; sudo ss -ltnp | grep -c ":$p"; done
# all three must print 0
```

- [ ] Add all three to the port registry table in `README-add-service.md`.

## 3. Database

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

There is no migration step — `db.js`'s `init()` builds the schema on first boot
and is safe to re-run.

## 4. Copy the code up

- [ ] On the server, make the destinations:

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
       admin@<DOMAIN>:/srv/faaglarna-api/

scp export-service/export_server.py export-service/requirements.txt `
       fountain.py fdx.py pdf_layout.py pagination.py `
       admin@<DOMAIN>:/srv/faaglarna-export/
scp -r export-service/deploy admin@<DOMAIN>:/srv/faaglarna-export/
```

> The sidecar needs those four `.py` files from the **repo root** — it imports
> them unchanged rather than carrying its own copy. Forgetting them is an
> `ImportError` on first start.

## 5. Install dependencies

- [ ] API:

```bash
cd /srv/faaglarna-api && npm ci --omit=dev
```

- [ ] Sidecar:

```bash
cd /srv/faaglarna-export
sudo apt install -y python3-venv        # usually already there
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

## 6. Secrets

- [ ] `cd /srv/faaglarna-api && cp .env.example .env`
- [ ] Set `PGPASSWORD=<DBPASS>` in it.
- [ ] `ALLOWED_ORIGINS` only matters if the frontend gets a custom domain —
      `*.github.io` and localhost are already allowed.

The sidecar has no `.env`. It holds no secrets and reaches no database.

## 7. Start both under pm2

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

## 8. nginx + TLS

- [ ] Install the config — **use ours, not the generic template**:

```bash
cd /srv/faaglarna-api
sudo cp deploy/nginx-faaglarna.conf /etc/nginx/sites-available/<DOMAIN>
sudo sed -i 's/<DOMAIN>/<DOMAIN>/g' /etc/nginx/sites-available/<DOMAIN>
sudo ln -s /etc/nginx/sites-available/<DOMAIN> /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d <DOMAIN>
```

- [ ] Verify from outside the box:

```bash
curl -s https://<DOMAIN>/api/health
```

> **The generic template in `README-add-service.md` breaks WebSockets.** It sets
> `proxy_http_version 1.1` but not the `Upgrade`/`Connection` headers, and
> nginx's default `proxy_read_timeout` of 60s drops idle editing sessions.
> `nginx-faaglarna.conf` sets both.
>
> Symptom if this is wrong: collaboration connects fine, then dies after about a
> minute of not typing.

## 9. Create your account

- [ ] There is no public registration, so bootstrap yourself:

```bash
cd /srv/faaglarna-api
node create-user.js <ADMIN_EMAIL> 'a-long-password' 'Your Name'
```

Re-running this for an existing address resets the password — that is also the
password-reset path, since there is no email flow.

## 10. Point the frontend at it

- [ ] In `static/config.js`:

```js
window.FAAGLARNA_CLOUD = 'https://<DOMAIN>';
```

- [ ] Commit and push. Pages redeploys and the sign-in prompt appears.

Setting it back to `''` is the instant rollback — no server change needed.

## 11. First real sign-in — expect to find bugs here

- [ ] Sign in on the hosted app.
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

## 12. Operations (do not skip — this is the part that saves you later)

- [ ] Add `faaglarna` to the nightly `pg_dump` (per `README-add-service.md` §8):

```bash
sudo mkdir -p /var/backups/faaglarna
sudo chown postgres:postgres /var/backups/faaglarna
sudo -u postgres /usr/local/bin/backup-ukeportalen.sh
ls -lh /var/backups/faaglarna      # a .sql.gz must appear before you trust cron
```

- [ ] Restore-test that first dump into a scratch database, so you know the
      rollback works before you need it.
- [ ] UptimeRobot keyword monitor on `https://<DOMAIN>/api/ready`, alerting when
      the body does **not** contain `ready`.

---

## If something breaks

| Symptom | Likely cause |
|---|---|
| certbot fails the challenge | DNS not propagated yet — re-check `dig +short <DOMAIN>` |
| Service crash-loops on boot | Missing `GRANT ALL ON SCHEMA public`, or a wrong `PGPASSWORD` in `.env` |
| `pm2 status` shows climbing restarts | Boot-time crash — read `pm2 logs faaglarna-api` *before* restarting again |
| Collaboration connects then dies after ~1 min | nginx missing the `Upgrade`/`Connection` headers or the long `proxy_read_timeout` |
| Exports return 503 | Sidecar is down (`pm2 status`), or `EXPORT_SERVICE_URL` is unset in `.env` |
| Sign-in fails with a CORS error | Frontend origin is not `*.github.io` — add it to `ALLOWED_ORIGINS` |
| A port silently collides | `sudo ss -ltnp \| grep ':300'` — pm2 shows the loser crash-looping |

Triage always starts the same way:

```bash
pm2 status
pm2 logs faaglarna-api --lines 50 --nostream
curl -s -o /dev/null -w '%{http_code}\n' https://<DOMAIN>/api/ready
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

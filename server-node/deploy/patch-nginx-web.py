#!/usr/bin/env python3
"""Apply the compression and web-app rules to the LIVE frontend nginx config.

    sudo python3 /srv/faaglarna-web/server-node/deploy/patch-nginx-web.py

WHY NOT JUST COPY nginx-faaglarna-web.conf OVER IT. Certbot rewrote the live
file when it issued the certificate: it added the `listen 443 ssl` block and the
certificate paths, and turned the port-80 server into a redirect. The committed
config is the HTTP-only starting point, so copying it would delete the TLS
configuration - and `nginx -t` would still pass, because an HTTP-only server is
perfectly valid. The site would reload and stop serving HTTPS.

So this edits in place, changes only what it recognises, and is safe to run
twice. It backs the file up, tests the result, and puts the backup back if the
test fails.
"""
import datetime
import re
import shutil
import subprocess
import sys
from pathlib import Path

LIVE = Path("/etc/nginx/sites-available/faaglarna.lektorensrud.no")

GZIP_OLD = ("gzip_types text/plain text/css application/javascript "
            "application/json image/svg+xml;")
GZIP_NEW = ("# text/javascript is what nginx actually labels a .js file as; without it\n"
            "    # every script here, the 122 kB Yjs bundle included, went uncompressed.\n"
            "    gzip_types text/plain text/css application/javascript text/javascript\n"
            "               application/json application/manifest+json image/svg+xml;")

BLOCKS = """
    # The service worker decides what every other file may be. Browsers already
    # revalidate it, but a cached one would pin the app to an old shell for as
    # long as it lived, so it is explicit here.
    location = /sw.js {
        add_header Cache-Control "no-cache";
    }

    # .webmanifest has no entry in nginx's stock mime.types and would be served
    # as application/octet-stream, which browsers discard - so the file is named
    # .json, which the stock table already serves acceptably. This only upgrades
    # it to the exact type and keeps it out of caches.
    location = /manifest.json {
        types { } default_type application/manifest+json;
        add_header Cache-Control "no-cache";
    }
"""

ANCHOR = "    location / {"


def main() -> int:
    if not LIVE.exists():
        print(f"not found: {LIVE}", file=sys.stderr)
        return 1

    text = LIVE.read_text(encoding="utf-8")
    original = text
    did = []

    if "text/javascript" in text:
        print("  already done: gzip_types")
    elif GZIP_OLD in text:
        text = text.replace(GZIP_OLD, GZIP_NEW, 1)
        did.append("gzip_types now covers .js and the manifest")
    else:
        print("  SKIPPED gzip_types: the line has been changed by hand, leaving it alone")

    if "location = /manifest.json" in text:
        print("  already done: sw.js and manifest.json blocks")
    elif ANCHOR in text:
        text = text.replace(ANCHOR, BLOCKS + "\n" + ANCHOR, 1)
        did.append("added the sw.js and manifest.json location blocks")
    else:
        print("  SKIPPED location blocks: no `location / {` to anchor to", file=sys.stderr)

    if not did:
        print("nothing to change.")
        return 0

    # TLS must survive this. If certbot's lines are not still there afterwards,
    # something went wrong and the file is not worth installing.
    if "ssl_certificate" in original and "ssl_certificate" not in text:
        print("REFUSING: the edit would have dropped the TLS configuration", file=sys.stderr)
        return 1

    stamp = datetime.datetime.now().strftime("%Y%m%dT%H%M%S")
    backup = LIVE.with_suffix(f".bak-{stamp}")
    shutil.copy2(LIVE, backup)
    LIVE.write_text(text, encoding="utf-8")
    print(f"  backup: {backup}")
    for d in did:
        print(f"  {d}")

    test = subprocess.run(["nginx", "-t"], capture_output=True, text=True)
    if test.returncode != 0:
        shutil.copy2(backup, LIVE)
        print("nginx -t FAILED, restored the backup:\n" + test.stderr, file=sys.stderr)
        return 1

    reload_ = subprocess.run(["systemctl", "reload", "nginx"], capture_output=True, text=True)
    if reload_.returncode != 0:
        shutil.copy2(backup, LIVE)
        subprocess.run(["systemctl", "reload", "nginx"])
        print("reload failed, restored the backup:\n" + reload_.stderr, file=sys.stderr)
        return 1

    print("nginx reloaded.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env bash
# Nightly PostgreSQL dump of the Faaglarna database, gzipped, kept ~30 days.
#
# A near-copy of backup-ukeportalen.sh, deliberately kept as its OWN script
# rather than a second dump line in that one: both use `set -euo pipefail`, so a
# failure dumping one database would silently skip the other. Separate scripts
# and separate cron lines fail independently.
#
# Install:
#   sudo cp /srv/faaglarna-api/deploy/backup-faaglarna.sh /usr/local/bin/backup-faaglarna.sh
#   sudo chmod +x /usr/local/bin/backup-faaglarna.sh
#   sudo mkdir -p /var/backups/faaglarna
#   sudo chown postgres:postgres /var/backups/faaglarna
#   sudo touch /var/log/faaglarna-backup.log
#   sudo chown postgres:postgres /var/log/faaglarna-backup.log
#
# Test by hand BEFORE trusting cron, and confirm a .sql.gz appears:
#   sudo -u postgres /usr/local/bin/backup-faaglarna.sh
#   ls -lh /var/backups/faaglarna
#
# Cron (run as the postgres user so no password is needed - peer auth):
#   sudo crontab -u postgres -e
#   40 2 * * * /usr/local/bin/backup-faaglarna.sh >> /var/log/faaglarna-backup.log 2>&1
#
# 02:40 rather than 02:30 so it does not contend with the ukeportalen dump.
#
# NOTE: doc_state.ydoc is BYTEA - the CRDT state, and the actual content of every
# script. pg_dump handles it fine, but it means these dumps ARE the documents:
# there is no separate copy of the text on disk anywhere. Copy them off-box as a
# second layer (rsync/rclone to external storage); a local-only backup does not
# survive losing the VM.

set -euo pipefail

DB="faaglarna"
DIR="/var/backups/faaglarna"
KEEP_DAYS=30
STAMP="$(date +%F)"
OUT="${DIR}/faaglarna-${STAMP}.sql.gz"

mkdir -p "$DIR"

# pg_dump run as the postgres OS user connects via local peer auth.
pg_dump "$DB" | gzip > "$OUT"

# Verify the archive is intact before pruning old ones.
gunzip -t "$OUT"

# Prune dumps older than KEEP_DAYS.
find "$DIR" -name 'faaglarna-*.sql.gz' -type f -mtime "+${KEEP_DAYS}" -delete

echo "$(date '+%F %T') backup OK: ${OUT}"

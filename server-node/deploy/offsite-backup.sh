#!/usr/bin/env bash
# Pushes the nightly database dumps off the VM to OneDrive via rclone.
#
# WHY THIS EXISTS. /var/backups and /var/lib/postgresql are the same filesystem,
# so the local dumps protect against "I dropped a table" but not against losing
# the VM. For Faaglarna that gap is worse than for Ukeportalen: doc_state.ydoc is
# the ONLY copy of every script - there are no .fountain files on disk anywhere.
#
# Runs as `admin`, not `postgres`: rclone needs a home directory for its config,
# and the dumps are world-readable so no privilege is required to read them.
#
# Install:
#   sudo apt install -y rclone
#   rclone config                 # as admin - see README-deploy.md for the walkthrough
#   sudo cp /srv/faaglarna-api/deploy/offsite-backup.sh /usr/local/bin/offsite-backup.sh
#   sudo chmod +x /usr/local/bin/offsite-backup.sh
#
# Test by hand first, and read what it says it would do:
#   /usr/local/bin/offsite-backup.sh --dry-run
#   /usr/local/bin/offsite-backup.sh
#
# Cron (as admin, NOT postgres - 03:10, after the 02:40 dump has finished):
#   crontab -e
#   10 3 * * * /usr/local/bin/offsite-backup.sh >> /home/admin/offsite-backup.log 2>&1

set -euo pipefail

# Readable cwd for any invoking user - see backup-faaglarna.sh for why.
cd /

# An `alias` remote scoped to the backup subtree, NOT the full-drive remote:
#
#   rclone config create onedrive-backups alias #       remote onedrive-personal:Backups/faaglarna-vps
#
# This bounds the blast radius of a bug or a typo in this script - nothing above
# Backups/faaglarna-vps is addressable through it. It is NOT a security boundary:
# onedrive-personal: still exists in the same config, and anyone who can read
# rclone.conf holds a full-drive token. Microsoft's OAuth scopes are drive-level,
# so a real per-folder restriction is not available (Files.ReadWrite.AppFolder
# confines an app to /Apps/<name>, a folder Microsoft chooses, not one you do).
REMOTE="${OFFSITE_REMOTE:-onedrive-backups}"
REMOTE_DIR="${OFFSITE_DIR:-}"

# Databases to push. Add "ukeportalen" here to cover it too - it has the same
# off-box gap.
DBS=("faaglarna")

# Keep dumps off-box for longer than the 30 days kept locally.
REMOTE_KEEP_DAYS=90

DRY=()
[ "${1:-}" = "--dry-run" ] && DRY=(--dry-run) && echo "DRY RUN - nothing will be written or deleted"

command -v rclone >/dev/null || { echo "rclone is not installed"; exit 1; }

# Fail loudly if the remote is missing or unauthorised, rather than silently
# copying nothing for months.
if ! rclone lsd "${REMOTE}:" >/dev/null 2>&1; then
  echo "ERROR: rclone remote '${REMOTE}' is not usable (missing, or the token expired)."
  echo "       Check with: rclone lsd ${REMOTE}:"
  exit 1
fi

for DB in "${DBS[@]}"; do
  SRC="/var/backups/${DB}"
  DEST="${REMOTE}:${REMOTE_DIR:+${REMOTE_DIR}/}${DB}"

  if [ ! -d "$SRC" ]; then
    echo "$(date '+%F %T') skip ${DB}: ${SRC} does not exist"
    continue
  fi

  # `copy`, deliberately NOT `sync`. sync would mirror the local 30-day pruning
  # to the remote and delete the older copies - which is the whole point of
  # having them off-box. Retention is handled separately below.
  rclone copy "$SRC" "$DEST" \
    --include "${DB}-*.sql.gz" \
    --transfers 2 --checkers 4 \
    "${DRY[@]}"

  # Prune the remote on its own, longer schedule.
  rclone delete "$DEST" \
    --include "${DB}-*.sql.gz" \
    --min-age "${REMOTE_KEEP_DAYS}d" \
    "${DRY[@]}"

  COUNT=$(rclone lsf "$DEST" --include "${DB}-*.sql.gz" 2>/dev/null | wc -l)
  echo "$(date '+%F %T') offsite OK: ${DB} -> ${DEST} (${COUNT} dumps held)"
done

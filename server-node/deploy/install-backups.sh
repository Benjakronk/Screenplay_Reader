#!/usr/bin/env bash
# One-shot installer for the nightly pg_dump: the script, its directories, a
# first run by hand, and the cron entry.
#
# Run it as `admin`, NOT with sudo in front - it calls sudo itself where needed:
#
#   bash /srv/faaglarna-api/deploy/install-backups.sh
#
# Idempotent: re-running re-installs the script and leaves an existing cron
# entry alone rather than duplicating it.
#
# NOTE: this leaves the dumps on the SAME filesystem as the database, so they
# survive a bad migration but not a lost VM - and for Faaglarna that gap is
# real, because doc_state.ydoc is the only copy of every script. An off-site
# copy is deliberately not set up here; see README-deploy.md section 10b for
# why, and for what to do instead.

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUMP_CRON='40 2 * * * /usr/local/bin/backup-faaglarna.sh >> /var/log/faaglarna-backup.log 2>&1'

say() { printf '\n=== %s ===\n' "$1"; }

# Ask for the sudo password once, up front, so no later prompt can swallow input.
say "sudo"
sudo -v
echo "  credentials cached"

# ---------------------------------------------------------------- local dump
say "1. nightly pg_dump"
sudo install -m 755 "${DEPLOY_DIR}/backup-faaglarna.sh" /usr/local/bin/backup-faaglarna.sh
sudo mkdir -p /var/backups/faaglarna
sudo chown postgres:postgres /var/backups/faaglarna
sudo touch /var/log/faaglarna-backup.log
sudo chown postgres:postgres /var/log/faaglarna-backup.log
echo "  installed"

echo "  running it once by hand:"
sudo -u postgres /usr/local/bin/backup-faaglarna.sh | sed 's/^/    /'
ls -lh /var/backups/faaglarna/ | tail -n +2 | sed 's/^/    /'

# ------------------------------------------------------------------- schedule
say "3. cron"

# postgres's crontab: the dump.
if sudo crontab -u postgres -l 2>/dev/null | grep -qF 'backup-faaglarna.sh'; then
  echo "  postgres: dump already scheduled, left alone"
else
  sudo bash -c "( crontab -u postgres -l 2>/dev/null; echo '${DUMP_CRON}' ) | crontab -u postgres -"
  echo "  postgres: dump scheduled at 02:40"
fi


# -------------------------------------------------------------------- verify
say "4. verify"
echo "  local dumps:"
ls -1 /var/backups/faaglarna/ | sed 's/^/    /'
echo "  postgres crontab:"
sudo crontab -u postgres -l 2>/dev/null | grep faaglarna | sed 's/^/    /'

say "done"
echo "The dump runs nightly at 02:40 as postgres."
echo "Log: /var/log/faaglarna-backup.log"

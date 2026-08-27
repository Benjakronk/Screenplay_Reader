#!/usr/bin/env bash
# One-shot installer for both halves of the Faaglarna backup chain:
#
#   1. the nightly pg_dump  (runs as postgres, 02:40, -> /var/backups/faaglarna)
#   2. the off-site push    (runs as admin,    03:10, -> OneDrive via rclone)
#
# Run it as `admin`, NOT with sudo in front:
#
#   bash /srv/faaglarna-api/deploy/install-backups.sh
#
# It calls sudo itself where it needs to, and deliberately does not for the
# rclone step - rclone's config lives in admin's home, and running it as root
# would look in /root and fail.
#
# Idempotent: re-running it re-installs the scripts and leaves the existing cron
# entries alone rather than duplicating them.
#
# Prerequisite: `rclone config` has already created a remote named
# onedrive-personal. See README-deploy.md section 10b.

set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUMP_CRON='40 2 * * * /usr/local/bin/backup-faaglarna.sh >> /var/log/faaglarna-backup.log 2>&1'
PUSH_CRON='10 3 * * * /usr/local/bin/offsite-backup.sh >> /home/admin/offsite-backup.log 2>&1'

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

# ------------------------------------------------------------- off-site push
say "2. off-site push to OneDrive"
command -v rclone >/dev/null || { echo "  rclone is not installed - see README-deploy.md 10b"; exit 1; }
rclone lsd onedrive-personal: >/dev/null 2>&1 \
  || { echo "  rclone remote 'onedrive-personal' is not usable - run rclone config"; exit 1; }
echo "  rclone remote reachable"

sudo install -m 755 "${DEPLOY_DIR}/offsite-backup.sh" /usr/local/bin/offsite-backup.sh
echo "  installed"

echo "  running it once by hand (as admin, not root):"
/usr/local/bin/offsite-backup.sh | sed 's/^/    /'

# ------------------------------------------------------------------- schedule
say "3. cron"

# postgres's crontab: the dump.
if sudo crontab -u postgres -l 2>/dev/null | grep -qF 'backup-faaglarna.sh'; then
  echo "  postgres: dump already scheduled, left alone"
else
  sudo bash -c "( crontab -u postgres -l 2>/dev/null; echo '${DUMP_CRON}' ) | crontab -u postgres -"
  echo "  postgres: dump scheduled at 02:40"
fi

# admin's crontab: the push. Separate user, separate crontab.
if crontab -l 2>/dev/null | grep -qF 'offsite-backup.sh'; then
  echo "  admin: push already scheduled, left alone"
else
  ( crontab -l 2>/dev/null; echo "${PUSH_CRON}" ) | crontab -
  echo "  admin: push scheduled at 03:10"
fi

# -------------------------------------------------------------------- verify
say "4. verify"
echo "  local dumps:"
ls -1 /var/backups/faaglarna/ | sed 's/^/    /'
echo "  off-site copies:"
rclone lsf onedrive-personal:Backups/faaglarna-vps/faaglarna 2>/dev/null | sed 's/^/    /' \
  || echo "    (none yet)"
echo "  postgres crontab:"
sudo crontab -u postgres -l 2>/dev/null | grep faaglarna | sed 's/^/    /'
echo "  admin crontab:"
crontab -l 2>/dev/null | grep offsite | sed 's/^/    /'

say "done"
echo "The dump runs at 02:40 as postgres; the push at 03:10 as admin."
echo "Logs: /var/log/faaglarna-backup.log and /home/admin/offsite-backup.log"

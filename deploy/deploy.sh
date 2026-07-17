#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
release_id=$(date -u +%Y%m%d%H%M%S)
remote_release="/opt/primal/releases/$release_id"
archive=$(mktemp --suffix=.tar.gz)
cleanup() { rm -f "$archive"; }
trap cleanup EXIT

echo "Preparing release $release_id"
tar -C "$repo_dir" --exclude=.git --exclude=node_modules --exclude=dist --exclude=dist-server --exclude=coverage -czf "$archive" .

ssh upior-vps "mkdir -p '$remote_release'"
scp -q "$archive" "upior-vps:/tmp/primal-$release_id.tar.gz"
ssh upior-vps "tar -xzf '/tmp/primal-$release_id.tar.gz' -C '$remote_release' && rm -f '/tmp/primal-$release_id.tar.gz'"

ssh upior-vps bash -s -- "$remote_release" <<'REMOTE'
set -euo pipefail
release=$1

if ! id primal >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/primal --shell /usr/sbin/nologin primal
fi
install -d -o primal -g primal -m 0750 /var/lib/primal /var/lib/primal/backups
install -d -o root -g root -m 0755 /opt/primal/releases /etc/primal /var/www/letsencrypt

if ! command -v sqlite3 >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1 || ! command -v make >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y sqlite3 nodejs npm build-essential python3
fi
if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
    echo "Node.js 20 or newer is required on the VPS." >&2
    exit 1
fi

if [ ! -f /etc/primal/primal.env ]; then
    umask 077
    {
        echo "NODE_ENV=production"
        echo "HOST=127.0.0.1"
        echo "PORT=3001"
        echo "DATA_DIR=/var/lib/primal"
    } > /etc/primal/primal.env
else
    sed -i '/^ROOM_PASSCODE=/d; /^ROOM_PIN=/d' /etc/primal/primal.env
fi
chmod 600 /etc/primal/primal.env
chown root:root /etc/primal/primal.env

cd "$release"
npm ci --include=optional
npm run typecheck
npm run build
npm test
chmod +x deploy/backup.sh
chown -R root:root "$release"

install -m 0644 deploy/systemd/primal.service /etc/systemd/system/primal.service
install -m 0644 deploy/systemd/primal-backup.service /etc/systemd/system/primal-backup.service
install -m 0644 deploy/systemd/primal-backup.timer /etc/systemd/system/primal-backup.timer
install -m 0644 deploy/nginx/primal.upior.club.conf /etc/nginx/sites-available/primal.upior.club.conf
ln -sfn /etc/nginx/sites-available/primal.upior.club.conf /etc/nginx/sites-enabled/primal.upior.club.conf
if [ -L /etc/nginx/sites-enabled/primal.upior.club ]; then
    rm /etc/nginx/sites-enabled/primal.upior.club
fi
nginx -t
systemctl daemon-reload

previous=""
if [ -L /opt/primal/current ]; then
    previous=$(readlink -f /opt/primal/current || true)
fi
case "$previous" in
    /opt/primal/releases/*) ;;
    *) previous="" ;;
esac
ln -sfn "$release" /opt/primal/current.new
mv -Tf /opt/primal/current.new /opt/primal/current
systemctl enable --now primal.service primal-backup.timer
systemctl restart primal.service
if ! curl --fail --silent --show-error --retry 12 --retry-delay 1 --retry-connrefused http://127.0.0.1:3001/api/health >/dev/null; then
    if [ -n "$previous" ] && [ -d "$previous" ]; then
        ln -sfn "$previous" /opt/primal/current.rollback
        mv -Tf /opt/primal/current.rollback /opt/primal/current
        systemctl restart primal.service
        echo "Health check failed; restored previous release." >&2
    else
        rm -f /opt/primal/current
        systemctl stop primal.service
        echo "Health check failed; no previous release was available." >&2
    fi
    exit 1
fi
systemctl reload nginx
find /opt/primal/releases -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -nr | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf --
REMOTE

echo "Deployment healthy: https://primal.upior.club/api/health"

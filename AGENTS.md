# Primal operations

This repository deploys the single-room SoundCloud listen-along at `primal.upior.club`.

- SSH alias: `upior-vps` (root key auth; never store the root password here)
- Deploy: `./deploy/deploy.sh`
- Service: `primal.service`
- App user: `primal`
- Bind address: `127.0.0.1:3001`
- Releases: `/opt/primal/releases`; active symlink: `/opt/primal/current`
- Data: `/var/lib/primal/primal.db`
- Environment: `/etc/primal/primal.env` (mode `600`)
- Health: `https://primal.upior.club/api/health`
- Logs: `ssh upior-vps 'journalctl -u primal -n 200 --no-pager'`
- Follow logs: `ssh -t upior-vps 'journalctl -u primal -f'`
- Service status: `ssh upior-vps 'systemctl status primal --no-pager'`
- Daily backups: `/var/lib/primal/backups`, managed by `primal-backup.timer`

The deployment script creates the unprivileged service account. A room PIN is generated in the first host's browser, not stored in the environment, and the room resets 15 seconds after the last listener leaves. The SQLite file survives deployments for operations and backups, but temporary session rows are cleared whenever the service starts.

# Monthly DB size + backup integrity review

The price-tracker SQLite DB lives on CT 302 at `/opt/price-tracker/data/price-tracker.db`.
`scripts/rebuild.sh` snapshots it to `/opt/price-tracker-backups/` on every deploy
(rotating to keep the last 10). This review catches:

- **Runaway growth** — the DB doubling month-over-month is a smell (price_history
  rows piling up, AI summary text bloat, abandoned wishlist_claims).
- **Backup-rotation drift** — if a deploy ever fails partway through, we might end
  up with stale backups or zero backups; this surfaces that before it bites.
- **Disk space** — CT 302's root filesystem is finite. If we ever cross 50% of
  total disk, time to think about pruning history or moving the DB volume.

## Commands

Run from CT 300 (or anywhere with SSH access to CT 302):

```bash
# Live DB size
ssh root@192.168.1.166 'ls -lh /opt/price-tracker/data/price-tracker.db | awk "{print \$5}"'

# Row counts on the heavy tables
ssh root@192.168.1.166 'sqlite3 /opt/price-tracker/data/price-tracker.db "
  SELECT \"trackers\" AS tbl, COUNT(*) FROM trackers
  UNION ALL SELECT \"tracker_urls\", COUNT(*) FROM tracker_urls
  UNION ALL SELECT \"price_history\", COUNT(*) FROM price_history
  UNION ALL SELECT \"notifications\", COUNT(*) FROM notifications
  UNION ALL SELECT \"wishlist_claims\", COUNT(*) FROM wishlist_claims;
"'

# Backup directory state
ssh root@192.168.1.166 'ls -lht /opt/price-tracker-backups/ | head -15'

# Most-recent backup age (should be ≤ a week if you've deployed recently)
ssh root@192.168.1.166 'stat -c "%y" "$(ls -t /opt/price-tracker-backups/*.db | head -1)"'

# Disk usage on CT 302's root volume
ssh root@192.168.1.166 'df -h / | tail -1'

# Last 30 days of DB growth (size delta between oldest and newest backup)
ssh root@192.168.1.166 'cd /opt/price-tracker-backups && ls -t *.db | tail -1 | xargs ls -l; ls -t *.db | head -1 | xargs ls -l'
```

## Findings checklist

- [ ] DB size noted (compare to last month)
- [ ] Heavy-table row counts noted
- [ ] Most-recent backup is recent (< 14 days)
- [ ] Backup directory has ≥ 5 retained snapshots
- [ ] Root volume usage < 50%
- [ ] If DB > 500MB, consider pruning `price_history` older than N days
- [ ] If `notifications` table > 10k rows, consider archiving / cleanup task

## Tuning thresholds when they bite

- **DB > 500MB:** add a periodic `DELETE FROM price_history WHERE scraped_at < datetime('now', '-1 year')` cron + `VACUUM` afterward.
- **No recent backup despite deploys:** check `scripts/rebuild.sh` for a non-zero
  exit on the backup step. The script should `set -e` and fail loudly.
- **Too few snapshots retained:** the rotation logic in `rebuild.sh` keeps the
  newest 10. If you deploy < 10x/month, the rotation will naturally expire old
  ones; that's fine.

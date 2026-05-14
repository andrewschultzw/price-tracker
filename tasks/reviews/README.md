# Scheduled review playbooks

Canonical playbooks for periodic prod-health reviews of the price-tracker
service on CT 302. Each playbook is the source-of-truth set of commands +
findings checklist for one review cadence.

## How the loop works

1. A scheduled remote agent fires on a cron (every month / quarter).
2. The agent opens a GitHub issue against this repo. The issue title is
   stamped with the current month/quarter (e.g. *"📊 Monthly DB + backup
   review — 2026-06"*). The issue body contains the full playbook inline +
   a link to the canonical file here.
3. You (or a local Claude Code session on CT 300) see the issue, run the
   commands locally — SSH is required because CT 302 is on the LAN and the
   scheduled agent runs in Anthropic's cloud — and post findings as comments.
4. Close the issue when the checklist is complete.

The pattern, the rationale, and the next candidates for review are written
up in `tasks/lessons.md` (2026-05-14 entry).

## Active playbooks

| Cadence | Playbook | Notification cron (UTC) |
|---|---|---|
| Monthly, 1st | `db-size-and-backups.md` | `0 14 1 * *` |
| Monthly, 15th | `claude-api-cost.md` | `0 14 15 * *` |
| Quarterly, 1st of Jan/Apr/Jul/Oct | `stuck-trackers.md` | `0 14 1 1,4,7,10 *` |

## Adding a new playbook

1. Drop a new `.md` file in this directory with the playbook content
   (bash queries + findings checklist + interpretation guide).
2. Update the routine that opens the issue so its prompt embeds the new
   playbook. Routines live at https://claude.ai/code/routines.
3. Update the table above.

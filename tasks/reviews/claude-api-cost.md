# Monthly Claude API cost review

The AI Buyer's Assistant (PR #11) wires Claude Haiku 4.5 into the scrape
pipeline to generate per-tracker verdicts (BUY / WAIT / HOLD), alert-time
copy, and nightly summary backfills. Estimated spend at current scale was
~$0.20/month. This review confirms that's still true and catches:

- **Cost drift** — a Haiku call escaped a guard and is firing on every scrape
  instead of on price-change only.
- **Failure-rate creep** — `ai_failure_count` accumulating means we're burning
  tokens on calls that error out and we're not catching it elsewhere.
- **Summary backlog growth** — if `ai_summary_updated_at` is staler than
  `aiSummaryStalenessDays`, the nightly backfill isn't keeping up; either it's
  failing or the backlog has outgrown the cadence.

Skip this review if `AI_ENABLED=false` in CT 302's `/opt/price-tracker/.env`
(no calls are being made, no cost to review).

## Commands

```bash
# AI feature is on?
ssh root@192.168.1.166 'grep AI_ENABLED /opt/price-tracker/.env'

# Total failures across all trackers (running total — should be near-flat
# month-over-month, not climbing)
ssh root@192.168.1.166 'sqlite3 /opt/price-tracker/data/price-tracker.db "
  SELECT COALESCE(SUM(ai_failure_count), 0) AS total_failures FROM trackers;
"'

# Per-tracker failure outliers (trackers burning through repeated retries)
ssh root@192.168.1.166 'sqlite3 /opt/price-tracker/data/price-tracker.db "
  SELECT id, name, ai_failure_count
  FROM trackers
  WHERE ai_failure_count > 3
  ORDER BY ai_failure_count DESC
  LIMIT 10;
"'

# Generation volume in the last 30 days (verdict + summary attempts, from the
# structured sweep events — the old "Generated X for tracker" prose lines no
# longer exist in the logs; grepping for them silently returns 0)
ssh root@192.168.1.166 'journalctl -u price-tracker --since "30 days ago" -o cat' | python3 -c "
import sys, json
sums = verds = sweeps = 0
for line in sys.stdin:
    try: d = json.loads(line)
    except Exception: continue
    m = d.get('msg', '')
    if m == 'ai_backfill_sweep_done': sums += d.get('attempted', 0); sweeps += 1
    elif m == 'ai_verdict_backfill_sweep_done': verds += d.get('attempted', 0)
print(f'summaries={sums} verdicts={verds} nightly_sweeps={sweeps} (sweeps should be ~30)')
"

# Anthropic API errors in the last 30 days
ssh root@192.168.1.166 'journalctl -u price-tracker --since "30 days ago" -o cat | grep -E "anthropic|Anthropic" | grep -iE "error|failed|429|529" | wc -l'

# Stale summary backlog — count of trackers with summary older than
# aiSummaryStalenessDays (default 7) or never generated
# Excludes paused/blocked trackers: loadSignalsForTracker() returns null for
# them, so the nightly sweep skips them by design and they'd sit in this count
# forever (permanent floor, not backlog).
ssh root@192.168.1.166 'sqlite3 /opt/price-tracker/data/price-tracker.db "
  SELECT COUNT(*) AS stale_or_missing
  FROM trackers
  WHERE status NOT IN (\"paused\", \"blocked\")
    AND (ai_summary_updated_at IS NULL
     OR ai_summary_updated_at < strftime(\"%s\", \"now\", \"-7 days\") * 1000);
"'

# Actual cost: check the Anthropic console at https://console.anthropic.com/
# for the last 30 days of usage. There's no DB-side way to see real spend.
```

## Findings checklist

- [ ] `AI_ENABLED` value confirmed (review applies only when `true`)
- [ ] Total `ai_failure_count` sum noted (flat is healthy, climbing is a smell)
- [ ] No per-tracker failure outliers > 10 (if any, investigate that tracker
      specifically — its AI input may be malformed)
- [ ] Verdict + summary generation counts noted (rough call volume; ~30 nightly sweeps expected)
- [ ] Anthropic API error count noted (handful of 529 overloads is normal;
      sustained errors warrant looking at retry logic)
- [ ] Stale-summary backlog count noted (should trend toward 0 since the nightly
      backfill ran)
- [ ] Real spend pulled from console.anthropic.com — compare to ~$0.20/mo budget
- [ ] If spend > $2/mo: audit which call paths are firing; check `cron.ts` for
      a verdict generator that's slipped into the per-tick path

## Tuning thresholds when they bite

- **Spend > $5/mo at current scale:** there's a logic bug somewhere. Most
  likely: a verdict generator firing on every scrape instead of on price-change
  only. Check `cron.ts` for the `seller.last_price !== result.price` guard.
- **Sustained Anthropic 429s/529s:** wrap the call site in a higher-jitter
  retry, or back off the nightly backfill batch size.
- **Stale-summary backlog growing month-over-month:** the nightly backfill
  isn't keeping up. Either reduce `aiSummaryStalenessDays` (currently 7) or
  increase the batch size per nightly run.

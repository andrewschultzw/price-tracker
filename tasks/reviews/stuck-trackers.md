# Quarterly stuck-tracker audit

Trackers and per-seller URLs can land in `status='error'` or `status='blocked'`
and then stay there indefinitely. Examples:

- A retailer URL stops existing because the product was discontinued — scrapes
  fail forever, the tracker stays in `error` forever.
- A retailer WAF blanket-blocks our egress IP (see Home Depot / Best Buy) — the
  seller flips to `status='blocked'` and the scheduler stops checking it.
- A retailer redesigns its DOM and the auto-extraction pipeline can't find the
  price anymore — the tracker errors every cron tick until someone notices and
  either updates the URL or supplies a CSS selector via the element picker.

The quarterly audit asks: *do these stuck rows still represent something you
care about?* The answer is usually "no, just delete them." This review surfaces
the candidates so you can prune in one batch instead of one-off whenever you
happen to notice.

## Commands

```bash
# All sellers stuck in 'error' for > 90 days (cron has been failing
# repeatedly, you've probably forgotten this tracker exists)
ssh root@192.168.1.166 'sqlite3 /opt/price-tracker/data/price-tracker.db "
  SELECT tu.id AS seller_id, t.id AS tracker_id, t.name, tu.url, tu.last_error, tu.last_checked_at
  FROM tracker_urls tu
  JOIN trackers t ON t.id = tu.tracker_id
  WHERE tu.status = \"error\"
    AND tu.last_checked_at < datetime(\"now\", \"-90 days\")
  ORDER BY tu.last_checked_at;
"'

# All sellers in 'blocked' state (Akamai / Cloudflare IP-level rejection)
ssh root@192.168.1.166 'sqlite3 /opt/price-tracker/data/price-tracker.db "
  SELECT tu.id AS seller_id, t.id AS tracker_id, t.name, tu.url, tu.last_checked_at
  FROM tracker_urls tu
  JOIN trackers t ON t.id = tu.tracker_id
  WHERE tu.status = \"blocked\"
  ORDER BY tu.last_checked_at;
"'

# Trackers whose AGGREGATE status is 'error' (every seller errored — entire
# tracker is broken, not just one source)
ssh root@192.168.1.166 'sqlite3 /opt/price-tracker/data/price-tracker.db "
  SELECT id, name, last_error, last_checked_at, consecutive_failures
  FROM trackers
  WHERE status = \"error\"
  ORDER BY last_checked_at;
"'

# Trackers with no scrape in > 14 days (stale — paused, broken, or the
# cron is skipping them for some reason)
ssh root@192.168.1.166 'sqlite3 /opt/price-tracker/data/price-tracker.db "
  SELECT id, name, status, last_checked_at
  FROM trackers
  WHERE last_checked_at < datetime(\"now\", \"-14 days\")
     OR last_checked_at IS NULL
  ORDER BY last_checked_at;
"'
```

## Findings checklist

For each row in each query above, decide:

- [ ] **Delete** — the product is gone, the tracker is irrelevant. One
      `DELETE FROM tracker_urls WHERE id = ?` (or via the UI's red trash icon).
- [ ] **Replace URL** — same product, retailer redesigned the page. Update
      the seller URL or add a new seller via TrackerDetail.
- [ ] **Re-pick selector** — auto-extraction broken for this page. Use the
      browser-extension element picker to generate a CSS selector and save
      it to `trackers.css_selector`.
- [ ] **Keep blocked** — Home Depot / Best Buy will stay blocked indefinitely.
      The seller sits as a dormant record. Fine.
- [ ] **Manual Check Now** — for blocked sellers, run one manual check to see
      if the WAF block lifted. If it did, the seller flips back to `active`.

Summarize in the findings comment:
- N stuck-error sellers deleted
- N blocked sellers left as-is (still relevant)
- N URLs replaced
- N selectors re-picked

## When to consider longer-term changes

- **> 20 stuck-error sellers piling up between audits:** the auto-extraction
  pipeline has decayed. Look at which retailers are over-represented — likely
  one or two domains where the DOM changed. Time to add a new strategy or
  fixture.
- **More than 2 blocked retailers:** Akamai is targeting our IP class. Either
  rotate the egress IP, or invest in a residential proxy for known-blocked
  retailers.
- **Tracker has 5+ historical sellers, all errored:** the product itself is
  probably discontinued. Mark the tracker `status='paused'` instead of
  cycling through new retailers indefinitely.

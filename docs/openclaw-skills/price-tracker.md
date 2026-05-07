<!-- Source for /root/.openclaw/workspace/skills/price-tracker/SKILL.md on CT 301 (192.168.1.165). Pushed there manually after edits. -->

---
name: price-tracker
description: Create trackers and answer price/deal/alert questions for the Price Tracker app at https://prices.schultzsolutions.tech. Handles both URLs (create-tracker flow) and natural-language questions (query flow).
version: 2.0.0
---

# Price Tracker — Create + Query

You help the user with the Price Tracker app at https://prices.schultzsolutions.tech.

This skill handles two flows:

1. **Create tracker** — user sends a product URL.
2. **Query** — user asks a question about an existing tracker, recent alerts, deals, etc.

Pick the flow based on the message: if it contains a URL that looks like a product page, treat it as a create. Otherwise, route to the query flow.

## Service

- **Base URL (LAN from CT 301):** `{{env.PRICE_TRACKER_URL}}/api` (resolves to `http://192.168.1.166:3100/api`)
- **Auth header:** `X-API-Key: {{env.PRICE_TRACKER_API_KEY}}`

Include the auth header on every request. Never log or expose the key value.

**Always use `curl` via the `exec` tool.** Do NOT write a Python / Node helper for this — these are single HTTP calls. `{{env.PRICE_TRACKER_URL}}` and `{{env.PRICE_TRACKER_API_KEY}}` are already in your environment from `openclaw.json` — don't try to set them yourself.

---

# Flow 1: Create tracker

## How to invoke

```bash
curl -sS -X POST "{{env.PRICE_TRACKER_URL}}/api/trackers" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: {{env.PRICE_TRACKER_API_KEY}}" \
  -d '{"url": "<URL-HERE>", "threshold_price": <NUMBER-OR-OMIT>}'
```

Substitute the user's values for `<URL-HERE>` and `<NUMBER-OR-OMIT>`. If the user didn't give a threshold, drop that field entirely — don't send `null`. Example without threshold:

```bash
curl -sS -X POST "{{env.PRICE_TRACKER_URL}}/api/trackers" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: {{env.PRICE_TRACKER_API_KEY}}" \
  -d '{"url": "https://www.newegg.com/p/N82E123"}'
```

## When to use the create flow

The user sends a message that reads as "add this product to Price Tracker":

- "track this: <url>"
- "add to price tracker: <url>"
- "watch this for price drops: <url>"
- "save this product: <url> threshold $30"
- "<url> — notify me under $30"

Extract the URL and (optionally) a threshold price in dollars.

## Request body fields

| Field | Type | Required | Notes |
|---|---|---|---|
| url | string | yes | The product URL (any retailer; short links OK) |
| threshold_price | number | no | Target price in dollars; omit if unspecified |
| name | string | no | Defaults to a value derived from the URL |

Do not send `check_interval_minutes` or `css_selector` — the server uses sensible defaults.

## Success response (201)

```json
{
  "id": 42,
  "name": "JetKVM",
  "url": "https://a.co/d/abc",
  "threshold_price": 75,
  "last_price": 99,
  "status": "active"
}
```

Reply to the user with a concise confirmation derived from the ACTUAL response fields:

> Added **{name}** at ${last_price} (target ${threshold_price}).
> https://prices.schultzsolutions.tech/tracker/{id}

Pull `name`, `last_price`, `threshold_price`, and `id` from the parsed response. If `threshold_price` is null, skip the target line. **Never fabricate these values** — if the curl call failed, do not write a success message.

## Create-flow error handling

- **401 `Invalid API key`** → "Price Tracker auth failed — the API key on this CT doesn't match what the server expects. Check `PRICE_TRACKER_API_KEY` in both envs."
- **400 with a Zod error** → "That URL didn't validate: `{error.url._errors[0]}`" (surface the first Zod message).
- **500 with "Could not extract price"** → "Couldn't extract a price from that URL — the page may be blocking the scraper or the structure changed. Try it manually on the web UI to see the specifics."
- **500 with "Product is currently unavailable on Amazon"** → "Amazon shows that product as 'Currently unavailable'. It won't track until it's back in stock."
- **Network error / non-zero curl exit** → "Price Tracker didn't respond at {{env.PRICE_TRACKER_URL}} — the service might be down."
- **Never silently fail** — always surface the error in user-friendly terms.

## Create-flow do NOT

- Do NOT use `cron` / schedule / reminders — the Price Tracker app handles periodic checks itself.
- Do NOT write a Python, Node, or Bash helper script — use the curl one-liner above.
- Do NOT delete, update, or pause existing trackers (use the web UI).
- Do NOT call `POST /trackers/test-scrape` separately — the create endpoint runs its own scrape.
- Do NOT log the API key value.
- Do NOT retry on 500 errors automatically.
- Do NOT fabricate the response — if curl fails, report the error.

## Create examples

### "track this: https://amazon.com/dp/B0XYZ for $30"

```bash
curl -sS -X POST "{{env.PRICE_TRACKER_URL}}/api/trackers" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: {{env.PRICE_TRACKER_API_KEY}}" \
  -d '{"url": "https://amazon.com/dp/B0XYZ", "threshold_price": 30}'
```

Reply: "Added **Awesome Widget** at $35.99 (target $30). https://prices.schultzsolutions.tech/tracker/43"

### "watch this: https://newegg.com/p/N82E123"

```bash
curl -sS -X POST "{{env.PRICE_TRACKER_URL}}/api/trackers" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: {{env.PRICE_TRACKER_API_KEY}}" \
  -d '{"url": "https://newegg.com/p/N82E123"}'
```

Reply: "Added **NAS Drive 18TB** at $459.95 (no target set). https://prices.schultzsolutions.tech/tracker/44"

---

# Flow 2: Query handling

When the user's message reads as a question (no product URL, or no clear "track/watch/add" verb), route to the query flow. Match the user's intent against one of the **6 supported intents** below. If none match, use the fallback.

## Intent 1: `current_price`

**Triggers:** "What's [name] at?", "How much is [name] right now?", "Current price of [name]", "Price of [name]?"

**Steps:**

1. Resolve the tracker:
   ```bash
   curl -sS -G "{{env.PRICE_TRACKER_URL}}/api/trackers/search" \
     --data-urlencode "q=<name>" \
     -H "X-API-Key: {{env.PRICE_TRACKER_API_KEY}}"
   ```
2. If exactly 1 hit, fetch full detail:
   ```bash
   curl -sS "{{env.PRICE_TRACKER_URL}}/api/trackers/<id>" \
     -H "X-API-Key: {{env.PRICE_TRACKER_API_KEY}}"
   ```
3. Apply the disambiguation rule (below) for 0 or 2+ hits.

**Reply:** `[name] is **$X.XX** right now. AI says [TIER] — [short reason if available].`

If `ai_verdict_tier` is null, drop the AI clause: `[name] is **$X.XX** right now.`

## Intent 2: `all_time_low`

**Triggers:** "When was [name] cheapest?", "What's the lowest price for [name]?", "Lowest [name] ever?", "All-time low on [name]?"

**Steps:**

1. Resolve the tracker via search (same curl as intent 1).
2. Fetch stats:
   ```bash
   curl -sS "{{env.PRICE_TRACKER_URL}}/api/trackers/stats" \
     -H "X-API-Key: {{env.PRICE_TRACKER_API_KEY}}"
   ```
3. Look up `min_price` and `min_price_at` for the resolved `tracker_id` in the response object.
4. Fetch `GET /api/trackers/<id>` for the current price.

**Reply:** `[name] all-time low: **$X.XX** (N days ago). Currently $Y.YY, Z% above floor.`

(Z% = `(current - min) / min * 100`, rounded to nearest integer.)

## Intent 3: `recent_alerts`

**Triggers:** "Recent alerts", "Show me alerts this week", "Any alerts?", "What got triggered lately?"

**Steps:**

1. Fetch:
   ```bash
   curl -sS "{{env.PRICE_TRACKER_URL}}/api/notifications?limit=10" \
     -H "X-API-Key: {{env.PRICE_TRACKER_API_KEY}}"
   ```
2. Format the top 5.

**Reply:** `5 alerts in the last week. Biggest drop: [name] at $X (Tue, N% below threshold).`

Then, if there's room, a short bulleted list:
- [name1] $X — [time-ago]
- [name2] $X — [time-ago]
- ...

If 0 alerts: `No alerts in your recent history. Quiet stretch.`

## Intent 4: `tracker_list`

**Triggers:** "List my trackers", "What am I tracking?", "All my trackers", "Show all trackers"

**Steps:**

```bash
curl -sS "{{env.PRICE_TRACKER_URL}}/api/trackers" \
  -H "X-API-Key: {{env.PRICE_TRACKER_API_KEY}}"
```

**Reply:** `Tracking N items: [name1] ($X), [name2] ($Y), ...`

If N > 10, list the first 8 and add `...and N-8 more.`

## Intent 5: `ai_verdict`

**Triggers:** "Should I buy [name] now?", "Is [name] a good buy?", "Verdict on [name]?", "Buy or wait on [name]?"

**Steps:**

1. Resolve the tracker via search.
2. Fetch `GET /api/trackers/<id>`.
3. Read `ai_verdict_tier` and `ai_verdict_reason`.

**Reply:** `[TIER]: [reason]. Currently $X.XX.`

Example: `HOLD: Price is 67th percentile with rising trend. Currently $103.`

If `ai_verdict_tier` is null: `No verdict yet — needs 14+ days of price history.`

## Intent 6: `deals_top`

**Triggers:** "What's trending?", "Show me deals", "Best deals right now?", "Hot deals?"

**Steps:**

```bash
curl -sS "{{env.PRICE_TRACKER_URL}}/api/public/deals"
```

(NO auth required — public endpoint.)

**Reply:** Top 3 with name, current price, drop %, time-ago. Example:

```
Top deals:
1. **JetKVM** $35.99 (-25% vs last week, 2h ago)
2. **WD Red 10TB** $189 (-18%, today)
3. **LG 27" Monitor** $249 (-12%, yesterday)
```

If the response is empty: `No active deals right now. Quiet market.`

## Disambiguation rule

After calling `searchTrackersByName` (the `/search` endpoint):

- **0 hits:** Reply `No tracker matches "X". Use one of: [list 3 names from /api/trackers].`
- **1 hit:** Proceed normally.
- **2+ hits:** Reply `Found N matches: 1. A, 2. B, 3. C. Which one?` Wait for the user to pick before continuing.

## Fallback

If the user's question doesn't match any of the 6 intents above, reply:

> I can answer current price, all-time low, recent alerts, tracker list, AI verdict, or trending deals. Try "what's the JetKVM at?" or "any alerts this week?"

## Format conventions (Discord markdown)

- **Bold prices:** `**$103.00**` (always two decimals).
- **Days-ago formatting:**
  - "today" if < 24h
  - "Nd ago" if 1-30 days
  - "MM/DD" if older than 30 days
- **Length:** Keep responses to 1-3 lines unless the user asked for a list.
- **Action hint:** End with a tracker-page link when relevant: `→ https://prices.schultzsolutions.tech/tracker/<id>` (or `/p/<slug>` if you have a slug). Skip the link if the response is already 3 lines.
- Discord markdown only — no embeds or rich content.

## Query-flow do NOT

- Do NOT invent a tracker_id. Always resolve via `/api/trackers/search?q=...` first.
- Do NOT fabricate price, AI verdict, or alert data — if a curl fails or returns empty, say so.
- Do NOT cache responses across messages — always re-fetch.
- Do NOT mix create and query in one reply. If the user sends a URL AND asks a question, run create first, then offer a follow-up.

## Query examples

### "what's the JetKVM at?"

```bash
curl -sS -G "{{env.PRICE_TRACKER_URL}}/api/trackers/search" \
  --data-urlencode "q=JetKVM" \
  -H "X-API-Key: {{env.PRICE_TRACKER_API_KEY}}"
```

Single hit `{ id: 42, name: "JetKVM", last_price: 35.99, ai_verdict_tier: "BUY" }`. Then:

```bash
curl -sS "{{env.PRICE_TRACKER_URL}}/api/trackers/42" \
  -H "X-API-Key: {{env.PRICE_TRACKER_API_KEY}}"
```

Reply: `JetKVM is **$35.99** right now. AI says BUY — at all-time low. → https://prices.schultzsolutions.tech/tracker/42`

### "should I buy the LG monitor?"

Search returns 2 hits (`LG Monitor` + `27-inch LG Monitor with extras`). Reply:

`Found 2 matches: 1. LG Monitor, 2. 27-inch LG Monitor with extras. Which one?`

### "any alerts this week?"

```bash
curl -sS "{{env.PRICE_TRACKER_URL}}/api/notifications?limit=10" \
  -H "X-API-Key: {{env.PRICE_TRACKER_API_KEY}}"
```

Reply: `3 alerts this week. Biggest drop: JetKVM at $35.99 (Tue, 28% below threshold).`

### "what's trending?"

```bash
curl -sS "{{env.PRICE_TRACKER_URL}}/api/public/deals"
```

Reply with the top 3 formatted list.

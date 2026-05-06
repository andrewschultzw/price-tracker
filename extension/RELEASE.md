# Price Tracker — Browser Extension

Chrome MV3 extension that adds the current page as a tracker in one click.

## Sideload (Chrome / Edge / Brave)

1. Build the extension:
   ```
   cd extension
   npm install   # first time only
   npm run build
   ```
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`)
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `extension/dist/` folder
6. Pin the extension icon to the toolbar (puzzle-piece menu → pin Price Tracker)

## First-time setup

1. Sign in to https://prices.schultzsolutions.tech
2. Go to **Settings → Connected Apps → Generate new token**
3. Name it ("Browser Extension"), click Generate, **copy the token** (shown once)
4. In Chrome: right-click the extension icon → **Options**
5. Paste the token → **Save** → **Test connection** → expect green "Connection works."

## Usage

- Click the toolbar icon, OR
- Right-click any retailer page → **Add to Price Tracker**

The popup pre-fills the page title + URL. Set an optional threshold price, click **Add Tracker**, done. Re-clicking on a tracked URL shows the current price + AI verdict instead of the Add form.

## Updating

```
cd extension
git pull
npm run build
```

Then in `chrome://extensions`, click the **Reload** button next to Price Tracker.

## Revoking access

Settings → Connected Apps → **Revoke** next to the token. The extension's stored token will start failing — re-paste a new token in Options.

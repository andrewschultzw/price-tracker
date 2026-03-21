# Price Tracker — Todo

## Current Status
Code complete for phases 1-4. Backend + frontend compiles clean, API tested via curl.

## Done
- [x] Phase 1: Project scaffold, Express server, SQLite schema, CRUD routes
- [x] Phase 2: Playwright browser pool, 6 extraction strategies, price parser
- [x] Phase 3: Scheduler (node-cron + p-queue), Discord webhook notifications
- [x] Phase 4: React + Vite + Tailwind frontend (Dashboard, Add, Detail, Settings)

## Deployment (Phase 5)
- [ ] Create CT 302 on Proxmox (4 CPU, 4GB RAM, 16GB disk, Ubuntu 24.04)
- [ ] Install Node.js 22, Playwright Chromium deps
- [ ] Clone/deploy code to /opt/price-tracker
- [ ] Create systemd service
- [ ] NPM reverse proxy: prices.schultzsolutions.tech -> 192.168.1.166:3100
- [ ] Add CT 300 SSH key to CT 302
- [ ] Test with real product URLs

## Polish (Phase 6)
- [ ] CAPTCHA/block detection (graceful skip)
- [ ] Sanity checks on extracted prices (done in extractor)
- [ ] Test with 10+ real product URLs
- [ ] Proxmox snapshot after confirmed working

import { Router, Request, Response } from 'express';
import { getSavingsSummary } from '../db/queries.js';

// Public, unauthenticated savings rollup. Powers the marketing-style
// "we've saved users $X" footer and the /savings public page. By design
// returns ONLY aggregate numbers — no product names, retailer hosts, or
// URLs — so leaking the response to anonymous visitors is safe.
//
// Spec: docs/superpowers/specs/2026-05-20-purchased-tracking-design.md
export const publicSavingsRouter = Router();

publicSavingsRouter.get('/api/public/savings', (_req: Request, res: Response) => {
  // 5-minute cache: the underlying numbers change at human pace (a few
  // purchases per day) so a CDN/browser cache headers cut server load
  // without making the public footer look stale.
  res.set('Cache-Control', 'public, max-age=300');
  res.json(getSavingsSummary());
});

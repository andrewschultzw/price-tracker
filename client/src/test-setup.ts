import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { _resetPublicConfigCacheForTests } from './lib/use-public-config';

afterEach(() => {
  cleanup();
  // Module-level cache reset for usePublicConfig. Without this, the
  // first test in a vitest worker that triggers the boot-time fetch
  // can leave a pending in-flight promise (or a successful cached
  // value) that subsequent tests inherit. Most tests don't render
  // AffiliateDisclosure so the cache stays empty, but the reset is
  // cheap and prevents a future test from picking up stale state.
  _resetPublicConfigCacheForTests();
});

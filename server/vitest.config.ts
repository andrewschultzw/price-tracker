import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Only run tests from src/. dist/ may contain a stale compiled copy of
    // the tests from prior `tsc` runs before exclude was added; we never want
    // those to execute.
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
})

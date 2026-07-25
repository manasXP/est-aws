import { defineConfig } from 'vitest/config';

// Separate from vitest.config.ts on purpose: these tests need a real
// deployed sandbox stack, AWS credentials, and network access — never part
// of the default AWS-free `npm test` suite. Run via `npm run smoke`.
//
// Extensible by design (Refactor, STR-014): M1/M2 add their own
// ledger/payment smokes (toward the go-live checklist in
// EST-Deploy/provisioning-runbook.md §8) by dropping a new
// test/smoke/*.smoke.test.ts file — the glob picks it up automatically, no
// change needed here or in ci.yml's `deploy` job.
export default defineConfig({
  test: {
    include: ['test/smoke/**/*.smoke.test.ts'],
    testTimeout: 30_000,
  },
});

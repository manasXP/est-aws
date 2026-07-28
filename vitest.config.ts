import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./test/setup.ts'],
    // test/smoke/** needs a real deployed sandbox stack and AWS credentials —
    // run separately via `npm run smoke` (vitest.smoke.config.ts), never as
    // part of this AWS-free default suite.
    exclude: [...configDefaults.exclude, 'test/smoke/**'],
    // The local Blocks runtime backs `Database` with a file-based PGlite
    // instance shared across every test file that imports it (`.bb-data/`).
    // Running test files in parallel worker processes races concurrent
    // writers against that single file store and aborts PGlite's WASM
    // engine (found in STR-004). Test files run sequentially instead.
    fileParallelism: false,
    // Vitest's default is 5000ms, which several money-path and export tests
    // sit uncomfortably close to: they drive multi-step flows (issue ->
    // verify -> approve, or a full export job) against the file-backed
    // PGlite store, and each step is a real round trip. Under CPU
    // contention -- CI runners, or several worktrees running suites at
    // once on one machine -- they cross it and fail as a bare
    // "Test timed out in 5000ms" in a file the diff never touched.
    //
    // Eight such failures are on record across `documents-api`,
    // `role-assignments`, `invoice-approvals`, `reconciliation`,
    // `late-fee-charges`, `tally-export-jobs` and `ec-invoices`, every one
    // of them green on a plain re-run. The most recent was measured at
    // 14413ms for a test that normally finishes well inside the limit.
    //
    // 20s is chosen to clear that observed worst case with room to spare
    // while still failing fast on a genuine hang. This does not make any
    // test slower -- a passing test returns as soon as it is done.
    testTimeout: 20_000,
  },
});

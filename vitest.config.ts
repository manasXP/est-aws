import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The local Blocks runtime backs `Database` with a file-based PGlite
    // instance shared across every test file that imports it (`.bb-data/`).
    // Running test files in parallel worker processes races concurrent
    // writers against that single file store and aborts PGlite's WASM
    // engine (found in STR-004). Test files run sequentially instead.
    fileParallelism: false,
  },
});

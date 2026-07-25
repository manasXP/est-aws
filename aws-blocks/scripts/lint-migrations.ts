#!/usr/bin/env node
import { lintMigrationsDir } from '../migrations-lint';
import { MIGRATIONS_DIR } from '../migrations-runner';

const results = lintMigrationsDir(MIGRATIONS_DIR);

for (const result of results.filter(r => r.destructive)) {
  const label = result.ok ? 'REVIEWED' : 'BLOCKED';
  console.warn(`[migrations-lint] ${label} destructive migration: ${result.file}${result.reason ? ` (${result.reason})` : ''}`);
}

const blocking = results.filter(r => !r.ok);
if (blocking.length > 0) {
  console.error(
    `[migrations-lint] ${blocking.length} migration(s) contain destructive DDL with no contract annotation: ` +
      blocking.map(r => r.file).join(', '),
  );
  process.exit(1);
}

console.log(`[migrations-lint] ${results.length} migration file(s) checked, none blocked.`);

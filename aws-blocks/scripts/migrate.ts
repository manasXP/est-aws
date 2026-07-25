#!/usr/bin/env node
import { db } from '../index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../migrations-runner';

const { applied } = await runLocalMigrations(db, MIGRATIONS_DIR);

if (applied.length === 0) {
  console.log('No pending migrations.');
} else {
  console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
}

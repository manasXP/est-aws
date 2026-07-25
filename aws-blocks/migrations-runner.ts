import { readdirSync } from 'node:fs';
import { loadMigrationsFromDir, runMigrations } from '@aws-blocks/data-common';
import type { Database } from '@aws-blocks/blocks';

// Shared by the local loop (this story) and the deploy-time Lambda invocation
// (STR-014) so the two environments read migrations from the same place and
// cannot drift.
export const MIGRATIONS_DIR = 'migrations';

export interface RunLocalMigrationsResult {
  applied: string[];
}

const VERSION_PREFIX = /^(\d+)_.+\.sql$/;

/**
 * Refuse a migrations directory where two files claim the same leading
 * version number (e.g. `001_a.sql` and `001_b.sql`) — Blocks' own migration
 * tracking keys off the full filename, so a version collision like this
 * would apply both in an unpredictable order rather than error.
 */
export function assertNoVersionCollisions(migrationsDir: string): void {
  const byVersion = new Map<string, string[]>();
  for (const file of readdirSync(migrationsDir)) {
    const match = file.match(VERSION_PREFIX);
    if (!match) continue;
    const files = byVersion.get(match[1]) ?? [];
    files.push(file);
    byVersion.set(match[1], files);
  }
  for (const [version, files] of byVersion) {
    if (files.length > 1) {
      throw new Error(
        `Migration version collision: version ${version} is used by multiple files: ${files.sort().join(', ')}`,
      );
    }
  }
}

/**
 * Apply pending versioned SQL migrations from `migrationsDir` to `db`'s local
 * Blocks database. Thin wrapper over Blocks' own migration engine
 * (`@aws-blocks/data-common`) plus the version-collision guard above.
 */
export async function runLocalMigrations(db: Database, migrationsDir: string): Promise<RunLocalMigrationsResult> {
  assertNoVersionCollisions(migrationsDir);
  const migrations = await loadMigrationsFromDir(migrationsDir);
  const engine = await db.getEngine();
  const applied = await runMigrations(engine, migrations);
  return { applied };
}

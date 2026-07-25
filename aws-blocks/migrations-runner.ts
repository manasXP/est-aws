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

// Every file loadMigrationsFromDir will actually load and run (data-common's
// own filter: any `.sql` file). The stricter VERSION_PREFIX check below must
// scan this exact same set, or a malformed filename could slip past the
// collision guard and still get executed. Exported so migrations-lint.ts
// (STR-012) scans the identical file set rather than a second, driftable
// definition of "what counts as a migration file".
export const SQL_FILE = /\.sql$/;
const VERSION_PREFIX = /^(\d{3})_.+\.sql$/;

/**
 * Refuse a migrations directory where a file doesn't follow the mandated
 * `NNN_description.sql` convention (zero-padded 3-digit version prefix —
 * see migrations/000_baseline.sql), or where two files claim the same
 * version number (e.g. `001_a.sql` and `001_b.sql`). Blocks' own migration
 * tracking keys off the full filename and applies files in plain
 * lexicographic order, so either mistake would apply migrations in an
 * unpredictable order rather than error.
 */
export function assertNoVersionCollisions(migrationsDir: string): void {
  const byVersion = new Map<string, string[]>();
  for (const file of readdirSync(migrationsDir)) {
    if (!SQL_FILE.test(file)) continue;
    const match = file.match(VERSION_PREFIX);
    if (!match) {
      throw new Error(
        `Migration filename "${file}" does not follow the required NNN_description.sql convention (zero-padded 3-digit version prefix).`,
      );
    }
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
 *
 * `db.getEngine()` is the only way to reach a `DatabaseEngine` for this —
 * neither `@aws-blocks/blocks` nor `@aws-blocks/bb-data` re-export
 * `loadMigrationsFromDir`/`runMigrations` any other way. It is JSDoc-marked
 * `@internal` upstream (not a TypeScript-private member); treat it as a
 * deliberate, narrow exception rather than blessed public API.
 */
export async function runLocalMigrations(db: Database, migrationsDir: string): Promise<RunLocalMigrationsResult> {
  assertNoVersionCollisions(migrationsDir);
  const migrations = await loadMigrationsFromDir(migrationsDir);
  const engine = await db.getEngine();
  const applied = await runMigrations(engine, migrations);
  return { applied };
}

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations } from '../../aws-blocks/migrations-runner';

// STR-011 — versioned SQL migration runner, local path (T-U1..T-U4: no TC
// case covers this repo-tooling behavior, so all four are genuine-gap IDs
// per the story).

function freshDb(): Database {
  return new Database(new Scope(`str-011-test-${randomUUID()}`), 'db');
}

function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'str-011-migrations-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const cleanupDirs: string[] = [];
const cleanupDbIds: string[] = [];

afterEach(() => {
  while (cleanupDirs.length) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  while (cleanupDbIds.length) rmSync(`.bb-data/${cleanupDbIds.pop()}`, { recursive: true, force: true });
});

describe('STR-011 versioned SQL migration runner (local)', () => {
  // T-U1
  it('applies all pending migration files in version order and records each in the tracking table', async () => {
    const dir = fixtureDir({
      '001_create_widgets.sql': 'CREATE TABLE widgets (id TEXT PRIMARY KEY);',
      '002_create_gadgets.sql': 'CREATE TABLE gadgets (id TEXT PRIMARY KEY);',
    });
    cleanupDirs.push(dir);
    const db = freshDb();
    cleanupDbIds.push(db.fullId);

    const result = await runLocalMigrations(db, dir);
    expect(result.applied).toEqual(['001_create_widgets.sql', '002_create_gadgets.sql']);

    const recorded = await db.query<{ name: string }>(sql`SELECT name FROM _migrations ORDER BY id`);
    expect(recorded.map(r => r.name)).toEqual(['001_create_widgets.sql', '002_create_gadgets.sql']);

    await expect(db.query(sql`SELECT * FROM widgets`)).resolves.toEqual([]);
    await expect(db.query(sql`SELECT * FROM gadgets`)).resolves.toEqual([]);
  });

  // T-U2
  it('is a no-op on a second run: no re-application, tracking table unchanged', async () => {
    const dir = fixtureDir({
      '001_create_widgets.sql': 'CREATE TABLE widgets (id TEXT PRIMARY KEY);',
    });
    cleanupDirs.push(dir);
    const db = freshDb();
    cleanupDbIds.push(db.fullId);

    const first = await runLocalMigrations(db, dir);
    expect(first.applied).toEqual(['001_create_widgets.sql']);

    const second = await runLocalMigrations(db, dir);
    expect(second.applied).toEqual([]);

    const recorded = await db.query<{ name: string }>(sql`SELECT name FROM _migrations`);
    expect(recorded).toHaveLength(1);
  });

  // T-U3
  it('leaves nothing recorded for a migration that fails, without touching prior applied versions', async () => {
    const dir = fixtureDir({
      '001_create_widgets.sql': 'CREATE TABLE widgets (id TEXT PRIMARY KEY);',
      '002_broken.sql': 'THIS IS NOT VALID SQL;',
    });
    cleanupDirs.push(dir);
    const db = freshDb();
    cleanupDbIds.push(db.fullId);

    await expect(runLocalMigrations(db, dir)).rejects.toThrow();

    const recorded = await db.query<{ name: string }>(sql`SELECT name FROM _migrations`);
    expect(recorded.map(r => r.name)).toEqual(['001_create_widgets.sql']);
  });

  // T-U4
  it('refuses to run when two migration files share the same version number', async () => {
    const dir = fixtureDir({
      '001_a.sql': 'CREATE TABLE a_table (id TEXT PRIMARY KEY);',
      '001_b.sql': 'CREATE TABLE b_table (id TEXT PRIMARY KEY);',
    });
    cleanupDirs.push(dir);
    const db = freshDb();
    cleanupDbIds.push(db.fullId);

    await expect(runLocalMigrations(db, dir)).rejects.toThrow(/version/i);

    // The collision check runs before any database write — the tracking
    // table is never even created.
    const exists = await db.query<{ regclass: string | null }>(
      sql`SELECT to_regclass('public._migrations') AS regclass`,
    );
    expect(exists[0]?.regclass).toBeNull();
  });
});

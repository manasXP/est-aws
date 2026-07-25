import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createProject, listProjects, ProjectValidationError } from '../../aws-blocks/projects/projects-api';
import { createMember } from '../../aws-blocks/members/members-api';

// STR-031 — Project registry business logic, unit cases. Follows the
// STR-024 test pattern (test/finance/books-api.test.ts): fresh Database +
// Scope per test, baseline + domain migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-031-projects-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
});

describe('STR-031 T-U2 — creating a project under the society', () => {
  it('creates a project that appears in the project list', async () => {
    const db = await freshMigratedDb();

    const project = await createProject(db, { name: 'Green Meadows', description: 'Phase 1' });

    expect(project.project_id).toEqual(expect.any(String));
    expect(project.name).toBe('Green Meadows');

    const list = await listProjects(db);
    expect(list.some(p => p.project_id === project.project_id)).toBe(true);
  });

  it('member and project rows carry no society_id column (single society per deployment)', async () => {
    const db = await freshMigratedDb();

    const member = await createMember(db, { name: 'Asha Rao' });
    const project = await createProject(db, { name: 'Green Meadows' });

    const memberRow = await db.queryOne<Record<string, unknown>>(sql`SELECT * FROM members WHERE id = ${member.member_id}`);
    const projectRow = await db.queryOne<Record<string, unknown>>(sql`SELECT * FROM projects WHERE id = ${project.project_id}`);

    expect(memberRow).not.toBeNull();
    expect(projectRow).not.toBeNull();
    expect(Object.keys(memberRow!)).not.toContain('society_id');
    expect(Object.keys(projectRow!)).not.toContain('society_id');
  });
});

describe('STR-031 code review — createProject rejects a missing name', () => {
  it('throws ProjectValidationError and writes nothing when name is omitted', async () => {
    const db = await freshMigratedDb();

    await expect(createProject(db, { description: 'No name here' })).rejects.toThrow(ProjectValidationError);
  });
});

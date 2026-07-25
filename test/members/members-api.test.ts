import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember, getMember } from '../../aws-blocks/members/members-api';

// STR-031 — Member registry business logic, unit cases. Follows the
// STR-024 test pattern (test/finance/books-api.test.ts): fresh Database +
// Scope per test, baseline + domain migrations applied via MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-031-members-test-${randomUUID()}`), 'db');
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

describe('STR-031 T-U1 — creating a member', () => {
  it('persists member_id, name, email, phone, address; member_status defaults to pending and joining_date is null until admission', async () => {
    const db = await freshMigratedDb();

    const member = await createMember(db, {
      name: 'Asha Rao',
      email: 'asha@example.com',
      phone: '9876543210',
      address: '12 MG Road',
    });

    expect(member.member_id).toEqual(expect.any(String));
    expect(member.name).toBe('Asha Rao');
    expect(member.email).toBe('asha@example.com');
    expect(member.phone).toBe('9876543210');
    expect(member.address).toBe('12 MG Road');
    expect(member.member_status).toBe('pending');
    expect(member.joining_date).toBeNull();

    const fetched = await getMember(db, member.member_id);
    expect(fetched).toEqual(member);
  });
});

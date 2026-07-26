import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember, getMember, MemberValidationError, updateMember } from '../../aws-blocks/members/members-api';

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

describe('STR-031 code review — createMember rejects a missing name', () => {
  it('throws MemberValidationError and writes nothing when name is omitted', async () => {
    const db = await freshMigratedDb();

    await expect(createMember(db, { email: 'noname@example.com' })).rejects.toThrow(MemberValidationError);
  });
});

describe('STR-031 code review — updateMember distinguishes omitted from explicit null', () => {
  it('clears email when the PATCH explicitly sets it to null', async () => {
    const db = await freshMigratedDb();

    const member = await createMember(db, { name: 'Asha Rao', email: 'asha@example.com' });

    const updated = await updateMember(db, member.member_id, { email: null });

    expect(updated!.email).toBeUndefined();
  });
});

describe('STR-042 code review — members are disjoint from employees too (symmetric to employees-api.ts T-U1)', () => {
  it('rejects a member whose email matches an existing employee, writing nothing', async () => {
    const db = await freshMigratedDb();
    await db.execute(
      sql`INSERT INTO employees (id, name, email) VALUES (${randomUUID()}, 'Existing Employee', 'shared@example.com')`,
    );

    await expect(
      createMember(db, { name: 'Would-Be Member', email: 'Shared@Example.com' }),
    ).rejects.toThrow(MemberValidationError);
  });

  it('rejects a member whose phone matches an existing employee, writing nothing', async () => {
    const db = await freshMigratedDb();
    await db.execute(
      sql`INSERT INTO employees (id, name, phone) VALUES (${randomUUID()}, 'Existing Employee', '9876543210')`,
    );

    await expect(
      createMember(db, { name: 'Would-Be Member', phone: '9876543210' }),
    ).rejects.toThrow(MemberValidationError);
  });

  it('rejects a PATCH that sets a member email to match an existing employee, writing nothing', async () => {
    const db = await freshMigratedDb();
    await db.execute(
      sql`INSERT INTO employees (id, name, email) VALUES (${randomUUID()}, 'Existing Employee', 'shared@example.com')`,
    );
    const member = await createMember(db, { name: 'Clean Member', email: 'clean@example.com' });

    await expect(
      updateMember(db, member.member_id, { email: 'Shared@Example.com' }),
    ).rejects.toThrow(MemberValidationError);

    const refetched = await getMember(db, member.member_id);
    expect(refetched!.email).toBe('clean@example.com');
  });
});

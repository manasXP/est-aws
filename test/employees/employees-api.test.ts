import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import {
  createEmployee,
  getEmployee,
  listEmployees,
  setEmployeeCapabilities,
  recordSalaryPayment,
  EmployeeValidationError,
} from '../../aws-blocks/employees/employees-api';
import { getExpenseLedgerEntries } from '../../aws-blocks/finance/books';

// STR-042 — Employee registry and salary-posting business logic, unit
// cases. Follows the STR-031 test pattern (test/members/members-api.test.ts):
// fresh Database + Scope per test, baseline + domain migrations applied via
// MIGRATIONS_DIR.

const cleanupDbs: Database[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-042-employees-test-${randomUUID()}`), 'db');
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

describe('STR-042 T-U1 — employees are disjoint from members (covers TC-MEM-023)', () => {
  it('rejects an employee whose email matches an existing member, writing nothing', async () => {
    const db = await freshMigratedDb();
    await db.execute(
      sql`INSERT INTO members (id, name, email) VALUES (${randomUUID()}, 'Existing Member', 'shared@example.com')`,
    );

    await expect(
      createEmployee(db, { name: 'Would-Be Employee', email: 'Shared@Example.com' }),
    ).rejects.toThrow(EmployeeValidationError);

    expect(await listEmployees(db)).toHaveLength(0);
  });

  it('rejects an employee whose phone matches an existing member, writing nothing', async () => {
    const db = await freshMigratedDb();
    await db.execute(
      sql`INSERT INTO members (id, name, phone) VALUES (${randomUUID()}, 'Existing Member', '9876543210')`,
    );

    await expect(
      createEmployee(db, { name: 'Would-Be Employee', phone: '9876543210' }),
    ).rejects.toThrow(EmployeeValidationError);

    expect(await listEmployees(db)).toHaveLength(0);
  });

  it('creates an employee with no contact-info overlap against members', async () => {
    const db = await freshMigratedDb();
    await db.execute(
      sql`INSERT INTO members (id, name, email, phone) VALUES (${randomUUID()}, 'Existing Member', 'member@example.com', '9000000000')`,
    );

    const employee = await createEmployee(db, {
      name: 'Clean Employee',
      email: 'employee@example.com',
      phone: '9111111111',
    });

    expect(employee.employee_id).toEqual(expect.any(String));
    expect(employee.name).toBe('Clean Employee');
    expect(employee.capabilities).toEqual([]);

    const fetched = await getEmployee(db, employee.employee_id);
    expect(fetched).toEqual(employee);
  });
});

describe('STR-042 T-U2 — salary payments post to the Expense Ledger (covers TC-MEM-023)', () => {
  it('posts a balanced entry visible under the employee as counterparty, amount as an exact decimal string', async () => {
    const db = await freshMigratedDb();
    const employee = await createEmployee(db, { name: 'Salaried Employee' });

    const entry = await recordSalaryPayment(db, employee.employee_id, {
      method: 'bank',
      amount: '25000.00',
      period: '2026-07',
      paid_on: '2026-07-25',
    });

    expect(entry).not.toBeNull();
    expect(entry!.book).toBe('expense');
    expect(entry!.amount).toBe('25000.00');
    expect(typeof entry!.amount).toBe('string');
    expect(entry!.direction).toBe('debit');
    expect(entry!.entry_date).toBe('2026-07-25');

    const expenseEntries = await getExpenseLedgerEntries(db, employee.employee_id);
    expect(expenseEntries).toHaveLength(1);
    expect(expenseEntries[0].amount).toBe('25000.00');
    expect(expenseEntries[0].counterparty_type).toBe('payee');
    expect(expenseEntries[0].counterparty_id).toBe(employee.employee_id);
  });

  it('returns null when the employee does not exist', async () => {
    const db = await freshMigratedDb();

    const entry = await recordSalaryPayment(db, randomUUID(), {
      method: 'cash',
      amount: '1000.00',
      period: '2026-07',
      paid_on: '2026-07-25',
    });

    expect(entry).toBeNull();
  });
});

describe('STR-042 T-U3 — only designated employees have logins (covers TC-MEM-023)', () => {
  it('a freshly created employee has no capabilities; designation grants exactly the requested set', async () => {
    const db = await freshMigratedDb();
    const employee = await createEmployee(db, { name: 'Designation Target' });
    expect(employee.capabilities).toEqual([]);

    const designated = await setEmployeeCapabilities(db, employee.employee_id, ['finance-recorder']);
    expect(designated!.capabilities).toEqual(['finance-recorder']);

    const refetched = await getEmployee(db, employee.employee_id);
    expect(refetched!.capabilities).toEqual(['finance-recorder']);
  });

  it('rejects an invalid capability name, writing nothing', async () => {
    const db = await freshMigratedDb();
    const employee = await createEmployee(db, { name: 'Bad Capability Target' });

    await expect(
      setEmployeeCapabilities(db, employee.employee_id, ['not-a-real-capability']),
    ).rejects.toThrow(EmployeeValidationError);

    const refetched = await getEmployee(db, employee.employee_id);
    expect(refetched!.capabilities).toEqual([]);
  });

  it('returns null when designating a nonexistent employee', async () => {
    const db = await freshMigratedDb();

    const result = await setEmployeeCapabilities(db, randomUUID(), ['data-entry']);
    expect(result).toBeNull();
  });
});

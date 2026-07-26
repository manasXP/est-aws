// STR-042: the employee registry's business logic, sitting between the
// `employees` table (migrations/007_employees.sql) and the HTTP layer
// (aws-blocks/employees/employees-routes.ts) -- kept separate so it's
// testable with a plain Database, no HTTP dispatch required (test/
// employees/employees-api.test.ts). Mirrors the members/members-api.ts +
// members/members-routes.ts split.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { ValidationError } from '../http/problem-response';
import { postJournalEntry } from '../finance/journal';
import { getBookEntry, type LedgerEntry } from '../finance/books-api';
import { parseMoney, InvalidMoneyError } from '../money';

export type EmployeeCapability = 'designated-verifier' | 'data-entry' | 'finance-recorder';

export const EMPLOYEE_CAPABILITIES: readonly EmployeeCapability[] = ['designated-verifier', 'data-entry', 'finance-recorder'];

/** The Admin OpenAPI's Employee shape (components/schemas/Employee). Money
 * as a decimal string, never parsed to a number. */
export interface Employee {
  employee_id: string;
  name: string;
  capabilities: EmployeeCapability[];
  designation?: string;
  email?: string;
  phone?: string;
  monthly_salary?: string;
  joined_on?: string;
}

/** The Admin OpenAPI's EmployeeInput shape. `capabilities` is intentionally
 * not writable through this type -- see createEmployee/updateEmployee and
 * setEmployeeCapabilities below (same reasoning as members-api.ts's
 * member_status). */
export interface EmployeeInput {
  name?: string;
  designation?: string;
  email?: string | null;
  phone?: string | null;
  monthly_salary?: string | null;
  joined_on?: string | null;
}

/** Domain rejection for an employee write -- nothing is written when this is thrown. */
export class EmployeeValidationError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'EmployeeValidationError';
  }
}

/**
 * STR-042 code review: `Money`-format validation for `monthly_salary`/
 * `amount` fields -- reuses money.ts's own `parseMoney` (rather than a
 * second regex) purely for its format check, translating its
 * `InvalidMoneyError` into an `EmployeeValidationError` so malformed money
 * strings produce a clean 422 through the existing employees-routes.ts
 * catch block instead of an uncaught crash (deep inside postJournalEntry,
 * or as a raw Postgres error against the NUMERIC(14,2) column).
 */
function assertValidMoney(value: string): void {
  try {
    parseMoney(value);
  } catch (e) {
    if (e instanceof InvalidMoneyError) {
      throw new EmployeeValidationError(e.message);
    }
    throw e;
  }
}

interface EmployeeRow {
  id: string;
  name: string;
  designation: string | null;
  email: string | null;
  phone: string | null;
  monthly_salary: string | null;
  // The local Blocks Database mock returns DATE columns as JS Date objects,
  // not strings -- toEmployee below formats to the OpenAPI's plain
  // YYYY-MM-DD date string.
  joined_on: string | Date | null;
  capabilities: string;
}

function toEmployee(row: EmployeeRow): Employee {
  const employee: Employee = {
    employee_id: row.id,
    name: row.name,
    capabilities: JSON.parse(row.capabilities) as EmployeeCapability[],
  };
  if (row.designation !== null) employee.designation = row.designation;
  if (row.email !== null) employee.email = row.email;
  if (row.phone !== null) employee.phone = row.phone;
  if (row.monthly_salary !== null) employee.monthly_salary = row.monthly_salary;
  if (row.joined_on !== null) {
    employee.joined_on = row.joined_on instanceof Date ? row.joined_on.toISOString().slice(0, 10) : row.joined_on;
  }
  return employee;
}

/**
 * STR-042 T-U1: employees are disjoint from members by definition
 * (Governance & Roles) -- a member-employee is a requirements change to
 * flag, not to support silently. Neither the story, TC-MEM-023, nor the
 * domain-model/governance-and-roles docs define a precise mechanism for
 * "coincide with a member identity"; contact-info overlap (email or phone
 * matching an existing member, case-insensitive on email) is the only
 * plausible signal given the current schema. This is an interpretation,
 * not a spec-confirmed rule -- flagged here for a future story/spec pass
 * to tighten if wrong.
 */
async function assertNotAMember(db: Database, input: EmployeeInput): Promise<void> {
  if (input.email) {
    const match = await db.queryOne<{ id: string }>(
      sql`SELECT id FROM members WHERE lower(email) = lower(${input.email})`,
    );
    if (match) {
      throw new EmployeeValidationError(`email ${input.email} already belongs to a member -- employees must be disjoint from members.`);
    }
  }
  if (input.phone) {
    const match = await db.queryOne<{ id: string }>(sql`SELECT id FROM members WHERE phone = ${input.phone}`);
    if (match) {
      throw new EmployeeValidationError(`phone ${input.phone} already belongs to a member -- employees must be disjoint from members.`);
    }
  }
}

/** `POST /employees` -- new employees start undesignated (capabilities: []),
 * the column default; only setEmployeeCapabilities changes that. */
export async function createEmployee(db: Database, input: EmployeeInput): Promise<Employee> {
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new EmployeeValidationError('name is required.');
  }
  if (input.monthly_salary !== undefined && input.monthly_salary !== null) {
    assertValidMoney(input.monthly_salary);
  }

  await assertNotAMember(db, input);

  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO employees (id, name, designation, email, phone, monthly_salary, joined_on)
        VALUES (${id}, ${input.name}, ${input.designation ?? null}, ${input.email ?? null}, ${input.phone ?? null}, ${input.monthly_salary ?? null}::numeric, ${input.joined_on ?? null}::date)`,
  );
  const employee = await getEmployee(db, id);
  return employee!;
}

/** `GET /employees/{employeeId}` -- a single employee, or `null` if it doesn't exist. */
export async function getEmployee(db: Database, employeeId: string): Promise<Employee | null> {
  const row = await db.queryOne<EmployeeRow>(sql`SELECT * FROM employees WHERE id = ${employeeId}`);
  return row ? toEmployee(row) : null;
}

/** `GET /employees` -- every employee (no pagination requested by this story). */
export async function listEmployees(db: Database): Promise<Employee[]> {
  const rows = await db.query<EmployeeRow>(sql`SELECT * FROM employees ORDER BY id`);
  return rows.map(toEmployee);
}

/**
 * `PATCH /employees/{employeeId}` -- updates the brief's editable
 * attributes. Rejects -- writing nothing -- a request carrying
 * `capabilities`: that field changes only through setEmployeeCapabilities
 * (PUT .../capabilities), never a raw PATCH. Returns `null` if the
 * employee doesn't exist.
 */
export async function updateEmployee(db: Database, employeeId: string, input: EmployeeInput & { capabilities?: unknown }): Promise<Employee | null> {
  if ('capabilities' in input) {
    throw new EmployeeValidationError('capabilities cannot be set by PATCH; use PUT /employees/{employeeId}/capabilities.');
  }

  const existing = await getEmployee(db, employeeId);
  if (!existing) return null;

  if ('monthly_salary' in input && input.monthly_salary !== undefined && input.monthly_salary !== null) {
    assertValidMoney(input.monthly_salary);
  }
  await assertNotAMember(db, input);

  await db.execute(
    sql`UPDATE employees SET
          name = ${input.name ?? existing.name},
          designation = ${'designation' in input ? input.designation ?? null : existing.designation ?? null},
          email = ${'email' in input ? input.email ?? null : existing.email ?? null},
          phone = ${'phone' in input ? input.phone ?? null : existing.phone ?? null},
          monthly_salary = ${'monthly_salary' in input ? input.monthly_salary ?? null : existing.monthly_salary ?? null}::numeric,
          joined_on = ${'joined_on' in input ? input.joined_on ?? null : existing.joined_on ?? null}::date
        WHERE id = ${employeeId}`,
  );
  return getEmployee(db, employeeId);
}

/**
 * `PUT /employees/{employeeId}/capabilities` -- replaces the employee's
 * granted capabilities. An empty list means not designated (no admin
 * account/login); designating an employee is granting exactly this set.
 * Returns `null` if the employee doesn't exist.
 */
export async function setEmployeeCapabilities(db: Database, employeeId: string, capabilities: unknown): Promise<Employee | null> {
  if (!Array.isArray(capabilities) || !capabilities.every(c => (EMPLOYEE_CAPABILITIES as readonly string[]).includes(c))) {
    throw new EmployeeValidationError(`capabilities must be an array of ${EMPLOYEE_CAPABILITIES.join(', ')}.`);
  }

  const existing = await getEmployee(db, employeeId);
  if (!existing) return null;

  await db.execute(sql`UPDATE employees SET capabilities = ${JSON.stringify(capabilities)} WHERE id = ${employeeId}`);
  return getEmployee(db, employeeId);
}

export interface RecordSalaryPaymentInput {
  method: 'bank' | 'cash';
  amount: string;
  period: string;
  paid_on: string;
  reference?: string;
}

/**
 * `POST /employees/{employeeId}/salary-payments` -- posts the salary
 * amount to the Expense Ledger through the E03 journal engine (AC2: never
 * a direct ledger write). No header/capability concerns here -- those stay
 * at the HTTP layer (employees-routes.ts), since headers carry no domain
 * meaning. Returns `null` if the employee doesn't exist; lets JournalError
 * propagate uncaught for the route layer to map to 422.
 */
export async function recordSalaryPayment(db: Database, employeeId: string, input: RecordSalaryPaymentInput): Promise<LedgerEntry | null> {
  const employee = await getEmployee(db, employeeId);
  if (!employee) return null;

  if (input.method !== 'bank' && input.method !== 'cash') {
    throw new EmployeeValidationError('method must be "bank" or "cash".');
  }
  if (typeof input.amount !== 'string' || input.amount === '') {
    throw new EmployeeValidationError('amount is required.');
  }
  assertValidMoney(input.amount);
  if (typeof input.period !== 'string' || input.period === '') {
    throw new EmployeeValidationError('period is required.');
  }
  if (typeof input.paid_on !== 'string' || input.paid_on === '') {
    throw new EmployeeValidationError('paid_on is required.');
  }

  const description = `Salary payment - ${employee.name} - ${input.period}${input.reference ? ` - ${input.reference}` : ''}`;

  // STR-042: passes postedAt explicitly, diverging from postJournalEntry's
  // documented default ("production callers omit it and get the posting
  // instant") -- a salary payment's ledger entry should reflect the actual
  // payment date the caller specified (paid_on), not the moment this
  // handler happens to run.
  const { entryId } = await postJournalEntry(
    db,
    description,
    [
      { accountId: 'expense', direction: 'debit', amount: input.amount, counterpartyType: 'payee', counterpartyId: employeeId },
      { accountId: input.method, direction: 'credit', amount: input.amount },
    ],
    { postedAt: input.paid_on },
  );

  return getBookEntry(db, 'expense', entryId);
}

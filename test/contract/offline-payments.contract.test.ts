import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { getCashBookEntries, getPaymentLedgerEntries } from '../../aws-blocks/finance/books';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { createMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';
import { asEmployee } from '../support/cognito-token';

// STR-095 T-U1/T-U4 -- the route-level cases for `POST
// /v1/charges/{chargeId}/offline-payment`. Uses the real `db`/`documents`
// singletons the registered RawRoutes read from (aws-blocks/index.ts), the
// same approach test/contract/invoice-payments.contract.test.ts takes; the
// service-level cases (T-U2/T-U3) live in test/payments/offline-payments.test.ts.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
  // Receipts cannot be issued until the society's receipt prefix is
  // configured (aws-blocks/finance/receipts.ts's formatReceiptNumber throws
  // on the migration's `''` placeholder). Set once for this file, exactly as
  // the service-level tests do against their own fresh databases.
  await db.execute(sql`UPDATE society_settings SET receipt_prefix = 'SOC' WHERE id = 'default'`);
});

/** Seeds a `due` charge against a fresh member/asset/ownership on the shared
 * singleton -- there is no charge-creation HTTP endpoint. */
async function seedDueCharge(amount = '1250.00'): Promise<string> {
  const project = await createProject(db, { name: `Offline Payment Project ${randomUUID()}` });
  const member = await createMember(db, { name: `Offline Payment Member ${randomUUID()}` });
  const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: `A-${randomUUID().slice(0, 8)}` });
  const ownership = await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO charges (id, member_id, ownership_id, amount, due_date, status)
        VALUES (${id}, ${member.member_id}, ${ownership.ownership_id}, ${amount}, '2026-08-01', 'due')`,
  );
  return id;
}

async function financeRecorderEmployeeId(): Promise<string> {
  const employee = await createEmployee(db, { name: `Offline Payment Recorder ${randomUUID()}` });
  await setEmployeeCapabilities(db, employee.employee_id, ['finance-recorder']);
  return employee.employee_id;
}

describe('STR-095 T-U1 -- POST /v1/charges/{chargeId}/offline-payment conforms to the Admin OpenAPI', () => {
  // Covers TC-PAY-060.
  it('records a cash payment for a finance-recorder-capable actor: 201 Receipt, Cash Book + Payment Ledger, charge paid', async () => {
    const chargeId = await seedDueCharge('1250.00');
    const employeeId = await financeRecorderEmployeeId();

    const response = await dispatchRequest(
      'POST',
      `/v1/charges/${chargeId}/offline-payment`,
      { method: 'cash', amount: '1250.00', received_on: '2026-08-05' },
      { 'Idempotency-Key': randomUUID(), ...(await asEmployee(db, employeeId)) },
    );

    expect(response.status).toBe(201);
    const body = response.body as { receipt_id: string; receipt_number: string; amount: string; charge_ids: string[]; payment_id: string | null };
    expect(body.amount).toBe('1250.00');
    expect(body.charge_ids).toEqual([chargeId]);
    // Null for offline receipts -- there is no gateway payment behind them
    // (the Receipt schema's own `payment_id` description).
    expect(body.payment_id).toBeNull();

    const op = await contractTest('admin', '/charges/{chargeId}/offline-payment', 'post');
    expect(() => op.expectValidResponse(201, response.body)).not.toThrow();

    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('paid');

    // One posting, both projections (STR-023) -- the debit lands in the Cash
    // Book, the credit in the Payment Ledger, from the same journal entry.
    const receipt = await db.queryOne<{ entry_id: string }>(sql`SELECT entry_id FROM receipts WHERE id = ${body.receipt_id}`);
    const entryId = receipt!.entry_id;

    const cashLines = (await getCashBookEntries(db)).filter(entry => entry.entry_id === entryId);
    expect(cashLines).toHaveLength(1);
    expect(cashLines[0].account_id).toBe('cash');
    expect(cashLines[0].direction).toBe('debit');
    expect(cashLines[0].amount).toBe('1250.00');

    const paymentLines = (await getPaymentLedgerEntries(db)).filter(entry => entry.entry_id === entryId);
    expect(paymentLines).toHaveLength(1);
    expect(paymentLines[0].account_id).toBe('member_dues');
    expect(paymentLines[0].direction).toBe('credit');
    expect(paymentLines[0].counterparty_type).toBe('member');
  });

  it('rejects an offline payment against an already-paid charge: 409', async () => {
    const chargeId = await seedDueCharge('900.00');
    const employeeId = await financeRecorderEmployeeId();
    const headers = { 'Idempotency-Key': randomUUID(), ...(await asEmployee(db, employeeId)) };

    await dispatchRequest('POST', `/v1/charges/${chargeId}/offline-payment`, { method: 'cash', amount: '900.00', received_on: '2026-08-05' }, headers);

    const response = await dispatchRequest(
      'POST',
      `/v1/charges/${chargeId}/offline-payment`,
      { method: 'cash', amount: '900.00', received_on: '2026-08-06' },
      { 'Idempotency-Key': randomUUID(), ...(await asEmployee(db, employeeId)) },
    );

    expect(response.status).toBe(409);
    const op = await contractTest('admin', '/charges/{chargeId}/offline-payment', 'post');
    expect(() => op.expectValidResponse(409, response.body)).not.toThrow();
  });

  // The Idempotency-Key header is required on every money-posting endpoint
  // (Admin Panel API), the same presence-only gate STR-042/STR-086 established.
  it('rejects a payment with the capability present but no Idempotency-Key: 422', async () => {
    const chargeId = await seedDueCharge('700.00');
    const employeeId = await financeRecorderEmployeeId();

    const response = await dispatchRequest(
      'POST',
      `/v1/charges/${chargeId}/offline-payment`,
      { method: 'cash', amount: '700.00', received_on: '2026-08-05' },
      { ...(await asEmployee(db, employeeId)) },
    );

    expect(response.status).toBe(422);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('validation_error');
  });
});

describe('STR-095 T-U4 -- the finance-recorder capability gates the endpoint', () => {
  it('rejects a caller lacking finance-recorder with 403 capability_required and posts nothing', async () => {
    const chargeId = await seedDueCharge('1500.00');
    const employee = await createEmployee(db, { name: `Uncapable Recorder ${randomUUID()}` });

    const before = await db.queryOne<{ count: string }>(sql`SELECT count(*)::text AS count FROM journal_entries`);

    const response = await dispatchRequest(
      'POST',
      `/v1/charges/${chargeId}/offline-payment`,
      { method: 'cash', amount: '1500.00', received_on: '2026-08-05' },
      { 'Idempotency-Key': randomUUID(), ...(await asEmployee(db, employee.employee_id)) },
    );

    expect(response.status).toBe(403);
    const body = response.body as { error: { code: string } };
    expect(body.error.code).toBe('capability_required');

    const after = await db.queryOne<{ count: string }>(sql`SELECT count(*)::text AS count FROM journal_entries`);
    expect(after!.count).toBe(before!.count);

    const charge = await db.queryOne<{ status: string }>(sql`SELECT status FROM charges WHERE id = ${chargeId}`);
    expect(charge!.status).toBe('due');
  });
});

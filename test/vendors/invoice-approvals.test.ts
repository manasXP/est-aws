import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database, FileBucket } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createVendor, createWorkOrder } from '../../aws-blocks/vendors/work-orders';
import { submitInvoice, InvoiceConflictError, type Invoice } from '../../aws-blocks/vendors/invoices';
import { verifyInvoice, recordApproval, designatedApproverCount, majorityThreshold } from '../../aws-blocks/vendors/invoice-approvals';
import { createEmployee, setEmployeeCapabilities, type Employee } from '../../aws-blocks/employees/employees-api';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import type { Member } from '../../aws-blocks/members/members-api';
import { assignRole } from '../../aws-blocks/members/role-assignments';
import { designateApprover } from '../../aws-blocks/members/capabilities';

// STR-083 -- invoice verification and EC-subset majority approval, unit
// cases against a fresh Database (no HTTP dispatch). Follows the STR-082
// test pattern (test/vendors/invoices.test.ts). T-U2 (the HTTP-level
// capability-gate case) and T-C1 (the OpenAPI contract case) live in
// test/contract/invoice-approvals.contract.test.ts instead, against the
// shared `db` singleton the registered routes read from -- matching
// test/contract/employees.contract.test.ts's own split.

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-083-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-083-test-${randomUUID()}`), 'documents');
  cleanupBuckets.push(bucket);
  return bucket;
}

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
  while (cleanupBuckets.length) {
    const bucket = cleanupBuckets.pop()!;
    rmSync(`.bb-data/${bucket.fullId}`, { recursive: true, force: true });
  }
});

/** A freshly submitted invoice against a fresh vendor/work order, mirroring
 * test/vendors/invoices.test.ts's own setup. */
async function submittedInvoice(db: Database, bucket: FileBucket): Promise<Invoice> {
  const vendor = await createVendor(db, { name: 'Acme Plumbing' });
  const workOrder = await createWorkOrder(db, {
    vendorId: vendor.id,
    scope: 'Fix leaking pipe',
    value: '5000.00',
    issuedOn: '2026-07-01',
  });
  await bucket.put('invoices/inv-1.pdf', 'invoice scan');
  const { invoice } = await submitInvoice(db, bucket, workOrder.id, {
    amount: '2000.00',
    invoiceDate: '2026-07-05',
    documentId: 'invoices/inv-1.pdf',
  });
  return invoice;
}

/** An employee holding the designated-verifier capability. */
async function verifierEmployee(db: Database): Promise<Employee> {
  const employee = await createEmployee(db, { name: 'Verifier Employee' });
  await setEmployeeCapabilities(db, employee.employee_id, ['designated-verifier']);
  return employee;
}

/** An active member holding an EC office (executive_member) plus the
 * designated-approver designation -- STR-044's own `assignEcRole` pattern
 * (test/members/capabilities.test.ts), extended with designateApprover. */
async function designatedApproverMember(db: Database, name: string): Promise<Member> {
  const member = await createMember(db, { name });
  await admitMember(db, member.member_id);
  await assignRole(db, member.member_id, 'management', '2026-01-01', 'ec-admin');
  await assignRole(db, member.member_id, 'executive_member', '2026-01-01', 'ec-admin');
  await designateApprover(db, member.member_id);
  return member;
}

describe('STR-083 T-U1 (TC-VEN-020) -- the designated-verifier employee verifies a submitted invoice', () => {
  // TC-VEN-020 | BE-U | Given a submitted invoice; When the designated
  // employee verifies it; Then it moves to `verified`
  it('moves the invoice to verified and records the verifier in invoice_events', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);

    const verified = await verifyInvoice(db, invoice.id, verifier.employee_id);

    expect(verified.status).toBe('verified');

    const events = await db.query<{ action: string; actor_id: string; actor_type: string }>(
      sql`SELECT action, actor_id, actor_type FROM invoice_events WHERE invoice_id = ${invoice.id} ORDER BY at`,
    );
    expect(events.map(e => e.action)).toEqual(['submitted', 'verified']);
    expect(events[1]).toMatchObject({ actor_id: verifier.employee_id, actor_type: 'employee' });
  });
});

describe('STR-083 T-U3 (TC-VEN-022) -- a verified invoice under a designated EC subset of 5', () => {
  // TC-VEN-022 | BE-U | Given a verified invoice and a designated EC subset
  // of 5; When 2 approve; Then it stays `verified` with `approval_progress`
  // 2-of-3-needed; When a 3rd approves; Then it is `approved`
  it('stays verified at 2-of-3-needed, then flips to approved at the 3rd distinct approval', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);
    await verifyInvoice(db, invoice.id, verifier.employee_id);

    const approvers: Member[] = [];
    for (const name of ['Approver 1', 'Approver 2', 'Approver 3', 'Approver 4', 'Approver 5']) {
      approvers.push(await designatedApproverMember(db, name));
    }
    expect(await designatedApproverCount(db)).toBe(5);
    expect(majorityThreshold(5)).toBe(3);

    const first = await recordApproval(db, invoice.id, approvers[0].member_id);
    expect(first.invoice.status).toBe('verified');
    expect(first.approvalProgress).toEqual({ approvedCount: 1, requiredCount: 3 });

    const second = await recordApproval(db, invoice.id, approvers[1].member_id);
    expect(second.invoice.status).toBe('verified');
    expect(second.approvalProgress).toEqual({ approvedCount: 2, requiredCount: 3 });

    const third = await recordApproval(db, invoice.id, approvers[2].member_id);
    expect(third.invoice.status).toBe('approved');
    expect(third.approvalProgress).toEqual({ approvedCount: 3, requiredCount: 3 });
  });
});

describe('STR-083 T-U4 (TC-VEN-023) -- the same designated approver approves twice', () => {
  // TC-VEN-023 | BE-U | Given a member approves twice; Then their approval
  // counts once
  it('the second call from the same member is a no-op; approved_count is unchanged', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);
    await verifyInvoice(db, invoice.id, verifier.employee_id);

    // A second designated approver keeps majorityThreshold(2) at 2, so the
    // repeat-approval no-op below stays observable at 'verified' (a single
    // designated approver would already flip to approved on the first call).
    const approver = await designatedApproverMember(db, 'Repeat Approver');
    await designatedApproverMember(db, 'Other Approver');

    const first = await recordApproval(db, invoice.id, approver.member_id);
    expect(first.invoice.status).toBe('verified');
    expect(first.approvalProgress.approvedCount).toBe(1);

    const second = await recordApproval(db, invoice.id, approver.member_id);
    expect(second.invoice.status).toBe('verified');
    expect(second.approvalProgress.approvedCount).toBe(1);
  });
});

describe('STR-083 T-U5 -- verify/approve are impossible outside their gating states', () => {
  it('approving a still-submitted (not yet verified) invoice fails with InvoiceConflictError', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const approver = await designatedApproverMember(db, 'Eager Approver');

    await expect(recordApproval(db, invoice.id, approver.member_id)).rejects.toThrow(InvoiceConflictError);
  });

  it('verifying an already-verified invoice fails with InvoiceConflictError', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);
    await verifyInvoice(db, invoice.id, verifier.employee_id);

    await expect(verifyInvoice(db, invoice.id, verifier.employee_id)).rejects.toThrow(InvoiceConflictError);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sql, Scope, Database, FileBucket } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createVendor, createWorkOrder } from '../../aws-blocks/vendors/work-orders';
import {
  submitInvoice,
  getInvoice,
  InvoiceConflictError,
  InvoiceValidationError,
  InvoiceForbiddenError,
  type Invoice,
} from '../../aws-blocks/vendors/invoices';
import {
  verifyInvoice,
  recordApproval,
  rejectInvoice,
  recordOverrideApproval,
  currentEcMemberCount,
  isCurrentEcMember,
  designatedApproverCount,
  majorityThreshold,
} from '../../aws-blocks/vendors/invoice-approvals';
import { createEmployee, setEmployeeCapabilities, type Employee } from '../../aws-blocks/employees/employees-api';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import type { Member } from '../../aws-blocks/members/members-api';
import { assignRole, vacateRole } from '../../aws-blocks/members/role-assignments';
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

/** An active member holding an EC office (executive_member), but WITHOUT the
 * designated-approver designation -- for STR-084's "any current EC member"
 * override checks, distinct from designatedApproverMember's narrower subset. */
async function ecMember(db: Database, name: string): Promise<Member> {
  const member = await createMember(db, { name });
  await admitMember(db, member.member_id);
  await assignRole(db, member.member_id, 'management', '2026-01-01', 'ec-admin');
  await assignRole(db, member.member_id, 'executive_member', '2026-01-01', 'ec-admin');
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

// T-U8/T-U9/T-U10: genuine gaps found in review, not in the story's own Red
// plan -- recordApproval's live majority recomputation had two real bugs
// (aws-blocks/vendors/invoice-approvals.ts) with no test coverage until
// this addition.
describe('STR-083 T-U8 -- a vote from a member who has since left the designated subset does not count', () => {
  it('excludes the stale vote from approvedCount once its voter is no longer currently designated', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);
    await verifyInvoice(db, invoice.id, verifier.employee_id);

    const approvers: Member[] = [];
    for (const name of ['Approver 1', 'Approver 2', 'Approver 3', 'Approver 4', 'Approver 5']) {
      approvers.push(await designatedApproverMember(db, name));
    }

    const first = await recordApproval(db, invoice.id, approvers[0].member_id);
    expect(first.approvalProgress).toEqual({ approvedCount: 1, requiredCount: 3 });
    const second = await recordApproval(db, invoice.id, approvers[1].member_id);
    expect(second.approvalProgress).toEqual({ approvedCount: 2, requiredCount: 3 });

    // Approver 1, who already voted, now leaves the EC subset -- their
    // earlier vote is stale and must stop counting. The remaining subset
    // is 4 (approvers 2-5), majority(4) = 3.
    await vacateRole(db, approvers[0].member_id, 'executive_member', '2026-07-10', 'ec-admin');
    expect(await designatedApproverCount(db)).toBe(4);

    // A genuinely new, currently-eligible vote (approver 3) must bring the
    // *valid* count to 2 (approver 2 + approver 3), not 3 (which is what
    // the unfixed code would compute by still counting approver 1's now-
    // stale vote) -- so this must stay verified, not flip to approved on
    // a majority that was never really reached by currently-eligible votes.
    const third = await recordApproval(db, invoice.id, approvers[2].member_id);
    expect(third.invoice.status).toBe('verified');
    expect(third.approvalProgress).toEqual({ approvedCount: 2, requiredCount: 3 });

    // A 4th currently-eligible vote genuinely crosses the majority.
    const fourth = await recordApproval(db, invoice.id, approvers[3].member_id);
    expect(fourth.invoice.status).toBe('approved');
    expect(fourth.approvalProgress).toEqual({ approvedCount: 3, requiredCount: 3 });
  });
});

describe('STR-083 T-U9 -- a member holding two concurrent EC offices counts once toward the majority denominator', () => {
  it('designatedApproverCount is not inflated by a member double-holding office', async () => {
    const db = await freshMigratedDb();
    const single = await designatedApproverMember(db, 'Single Office');
    const dual = await designatedApproverMember(db, 'Dual Office');
    // designatedApproverMember already grants 'executive_member' -- add a
    // second, distinct open EC office for the same member.
    await assignRole(db, dual.member_id, 'treasurer', '2026-01-01', 'ec-admin');

    expect(await designatedApproverCount(db)).toBe(2);
    expect(majorityThreshold(await designatedApproverCount(db))).toBe(2);
  });
});

describe('STR-083 T-U10 (AC3) -- an already-approved invoice cannot be approved again', () => {
  it('a 4th distinct approver is refused 409, and no duplicate approved event is written', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);
    await verifyInvoice(db, invoice.id, verifier.employee_id);

    const approvers: Member[] = [];
    for (const name of ['Approver 1', 'Approver 2', 'Approver 3', 'Approver 4']) {
      approvers.push(await designatedApproverMember(db, name));
    }
    await recordApproval(db, invoice.id, approvers[0].member_id);
    await recordApproval(db, invoice.id, approvers[1].member_id);
    const third = await recordApproval(db, invoice.id, approvers[2].member_id);
    expect(third.invoice.status).toBe('approved');

    await expect(recordApproval(db, invoice.id, approvers[3].member_id)).rejects.toThrow(InvoiceConflictError);

    const events = await db.query<{ action: string }>(
      sql`SELECT action FROM invoice_events WHERE invoice_id = ${invoice.id} AND action = 'approved'`,
    );
    expect(events).toHaveLength(1);
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

describe('STR-084 T-U1 (TC-VEN-024) -- a designated approver rejects a verified invoice with a mandatory reason', () => {
  it('moves the invoice to rejected, records the reason, and discards the accumulated approvals from any active threshold', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);
    await verifyInvoice(db, invoice.id, verifier.employee_id);

    // 5 designated approvers (majority(5) = 3) -- 2 accumulated approvals
    // stay short of the majority, so the invoice is still 'verified' at the
    // moment of rejection, proving the reject discards live progress, not
    // just an already-approved invoice.
    const approvers: Member[] = [];
    for (const name of ['Approver 1', 'Approver 2', 'Approver 3', 'Approver 4', 'Approver 5']) {
      approvers.push(await designatedApproverMember(db, name));
    }
    const first = await recordApproval(db, invoice.id, approvers[0].member_id);
    expect(first.invoice.status).toBe('verified');
    const second = await recordApproval(db, invoice.id, approvers[1].member_id);
    expect(second.invoice.status).toBe('verified');

    const rejected = await rejectInvoice(db, invoice.id, approvers[0].member_id, 'Amount does not match the PO');
    expect(rejected.status).toBe('rejected');

    const events = await db.query<{ action: string; notes: string | null }>(
      sql`SELECT action, notes FROM invoice_events WHERE invoice_id = ${invoice.id} ORDER BY at`,
    );
    expect(events.map(e => e.action)).toEqual(['submitted', 'verified', 'rejected']);
    expect(events[2].notes).toBe('Amount does not match the PO');

    // The 2 approvals cast before rejection no longer count toward any
    // active threshold: a brand new distinct designated approver attempting
    // recordApproval hits the 'verified'-only guard, not a silent resumption.
    await expect(recordApproval(db, invoice.id, approvers[2].member_id)).rejects.toThrow(InvoiceConflictError);
  });
});

describe('STR-084 T-U2 (TC-VEN-025) -- override supersedes rejection at a majority of the entire EC', () => {
  it('flips to approved once a majority of the entire EC (not just the designated subset) approves', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);
    await verifyInvoice(db, invoice.id, verifier.employee_id);

    // 3 total EC members (majorityThreshold(3) === 2): the designated
    // approver doubles as the rejecter, plus 2 plain EC members (not in the
    // designated-approver subset) who cast the override votes.
    const rejecter = await designatedApproverMember(db, 'Designated Rejecter');
    const ecOne = await ecMember(db, 'EC Member One');
    const ecTwo = await ecMember(db, 'EC Member Two');
    expect(await currentEcMemberCount(db)).toBe(3);
    expect(majorityThreshold(3)).toBe(2);

    await rejectInvoice(db, invoice.id, rejecter.member_id, 'Missing GST breakup');

    const first = await recordOverrideApproval(db, invoice.id, ecOne.member_id);
    expect(first.invoice.status).toBe('rejected');
    expect(first.approvalProgress).toEqual({ approvedCount: 1, requiredCount: 2 });

    const second = await recordOverrideApproval(db, invoice.id, ecTwo.member_id);
    expect(second.invoice.status).toBe('approved');
    expect(second.approvalProgress).toEqual({ approvedCount: 2, requiredCount: 2 });
  });
});

// Review-found gaps, not in the story's own Red list -- both a security
// review and a code review of the STR-084 diff independently flagged that
// isCurrentEcMember's authorization boundary (the whole reason this story
// adds a check STR-083 didn't have) shipped with no negative-path test.
// Same convention as STR-083's own T-U8/T-U9 additions.
describe('STR-084 -- recordOverrideApproval rejects a non-EC-member actor', () => {
  it('a plain member who has never held any EC office gets InvoiceForbiddenError, writing no approval row', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);
    await verifyInvoice(db, invoice.id, verifier.employee_id);
    const rejecter = await designatedApproverMember(db, 'Designated Rejecter');
    await rejectInvoice(db, invoice.id, rejecter.member_id, 'Missing GST breakup');

    const plainMember = await createMember(db, { name: 'Never On The EC' });
    await admitMember(db, plainMember.member_id);

    await expect(recordOverrideApproval(db, invoice.id, plainMember.member_id)).rejects.toThrow(InvoiceForbiddenError);

    const approvals = await db.query(sql`SELECT id FROM invoice_approvals WHERE invoice_id = ${invoice.id} AND is_override = true`);
    expect(approvals).toHaveLength(0);
  });

  it('a member whose EC office assignment has since closed (effective_to set) gets InvoiceForbiddenError', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);
    await verifyInvoice(db, invoice.id, verifier.employee_id);
    const rejecter = await designatedApproverMember(db, 'Designated Rejecter');
    await rejectInvoice(db, invoice.id, rejecter.member_id, 'Missing GST breakup');

    const lapsedEc = await ecMember(db, 'Former EC Member');
    await vacateRole(db, lapsedEc.member_id, 'executive_member', '2026-07-10', 'ec-admin');

    await expect(recordOverrideApproval(db, invoice.id, lapsedEc.member_id)).rejects.toThrow(InvoiceForbiddenError);
  });
});

describe('STR-084 -- isCurrentEcMember reflects only a currently-open EC office assignment', () => {
  it('is true for an open EC office holder, false for a plain member and a lapsed one', async () => {
    const db = await freshMigratedDb();
    const currentEc = await ecMember(db, 'Current EC Member');
    const plainMember = await createMember(db, { name: 'Never On The EC' });
    await admitMember(db, plainMember.member_id);
    const lapsedEc = await ecMember(db, 'Former EC Member');
    await vacateRole(db, lapsedEc.member_id, 'executive_member', '2026-07-10', 'ec-admin');

    expect(await isCurrentEcMember(db, currentEc.member_id)).toBe(true);
    expect(await isCurrentEcMember(db, plainMember.member_id)).toBe(false);
    expect(await isCurrentEcMember(db, lapsedEc.member_id)).toBe(false);
  });
});

describe('STR-084 -- currentEcMemberCount is not inflated by a member holding two EC offices', () => {
  it('counts a dual-office EC member once toward the override majority denominator', async () => {
    const db = await freshMigratedDb();
    const single = await ecMember(db, 'Single Office');
    const dual = await ecMember(db, 'Dual Office');
    await assignRole(db, dual.member_id, 'treasurer', '2026-01-01', 'ec-admin');

    expect(await currentEcMemberCount(db)).toBe(2);
    expect(majorityThreshold(await currentEcMemberCount(db))).toBe(2);
  });
});

describe('STR-084 T-U3 (TC-VEN-026) -- override attempt after resubmission closes the window', () => {
  it('fails with InvoiceConflictError, even for a genuine EC member, and writes no new invoice_approvals row', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);
    await verifyInvoice(db, invoice.id, verifier.employee_id);

    const rejecter = await designatedApproverMember(db, 'Designated Rejecter');
    const ecMemberActor = await ecMember(db, 'Genuine EC Member');
    await rejectInvoice(db, invoice.id, rejecter.member_id, 'Wrong vendor');

    await bucket.put('invoices/inv-1-resubmit.pdf', 'resubmitted invoice scan');
    await submitInvoice(db, bucket, invoice.workOrderId, {
      amount: '2000.00',
      invoiceDate: '2026-07-12',
      documentId: 'invoices/inv-1-resubmit.pdf',
      resubmissionOf: invoice.id,
    });

    const before = await db.queryOne<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM invoice_approvals WHERE invoice_id = ${invoice.id}`,
    );

    await expect(recordOverrideApproval(db, invoice.id, ecMemberActor.member_id)).rejects.toThrow(InvoiceConflictError);

    const after = await db.queryOne<{ count: string }>(
      sql`SELECT COUNT(*)::text AS count FROM invoice_approvals WHERE invoice_id = ${invoice.id}`,
    );
    expect(after!.count).toBe(before!.count);
  });
});

describe('STR-084 T-U4 (TC-VEN-027) -- resubmission attempt after override already completed', () => {
  it('fails with InvoiceConflictError, and writes no new invoice row on that work order', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);
    await verifyInvoice(db, invoice.id, verifier.employee_id);

    const rejecter = await designatedApproverMember(db, 'Designated Rejecter');
    const ecOne = await ecMember(db, 'EC Member One');
    const ecTwo = await ecMember(db, 'EC Member Two');
    await rejectInvoice(db, invoice.id, rejecter.member_id, 'Duplicate submission');

    await recordOverrideApproval(db, invoice.id, ecOne.member_id);
    const overridden = await recordOverrideApproval(db, invoice.id, ecTwo.member_id);
    expect(overridden.invoice.status).toBe('approved');

    await bucket.put('invoices/inv-1-late-resubmit.pdf', 'late resubmission scan');
    await expect(
      submitInvoice(db, bucket, invoice.workOrderId, {
        amount: '2000.00',
        invoiceDate: '2026-07-15',
        documentId: 'invoices/inv-1-late-resubmit.pdf',
        resubmissionOf: invoice.id,
      }),
    ).rejects.toThrow(InvoiceConflictError);

    const invoicesOnWorkOrder = await db.query(sql`SELECT id FROM invoices WHERE work_order_id = ${invoice.workOrderId}`);
    expect(invoicesOnWorkOrder).toHaveLength(1);
  });
});

describe('STR-084 T-U5 (TC-VEN-028) -- resubmission creates a fresh invoice that runs the full workflow independently', () => {
  it('links resubmission_of/resubmitted_as, and the fresh invoice runs submitted -> verified -> approved on its own', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);
    await verifyInvoice(db, invoice.id, verifier.employee_id);

    // A plain member, not in the designated-approver subset -- rejectInvoice
    // does no internal capability check (mirrors verifyInvoice/recordApproval's
    // own precedent), so this keeps the designated-approver subset scoped to
    // just the "Fresh Approver" below, isolating the assertion this test is
    // actually about (the fresh invoice runs its own workflow independently).
    const rejecter = await createMember(db, { name: 'Plain Rejecter' });
    await admitMember(db, rejecter.member_id);
    await rejectInvoice(db, invoice.id, rejecter.member_id, 'Needs corrected invoice number');

    await bucket.put('invoices/inv-1-resubmit.pdf', 'resubmitted invoice scan');
    const { invoice: resubmitted } = await submitInvoice(db, bucket, invoice.workOrderId, {
      amount: '2000.00',
      invoiceDate: '2026-07-12',
      documentId: 'invoices/inv-1-resubmit.pdf',
      resubmissionOf: invoice.id,
    });

    expect(resubmitted.resubmissionOf).toBe(invoice.id);
    expect(resubmitted.status).toBe('submitted');

    const predecessor = await getInvoice(db, invoice.id);
    expect(predecessor!.resubmittedAs).toBe(resubmitted.id);

    // The fresh invoice runs verify -> approve independently, with its own
    // designated subset -- unrelated to the predecessor's rejected history.
    await verifyInvoice(db, resubmitted.id, verifier.employee_id);
    const approver = await designatedApproverMember(db, 'Fresh Approver');
    const approved = await recordApproval(db, resubmitted.id, approver.member_id);
    expect(approved.invoice.status).toBe('approved');
  });
});

describe('STR-084 T-U6 -- rejecting without a reason fails validation', () => {
  it('fails with InvoiceValidationError and writes nothing', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const invoice = await submittedInvoice(db, bucket);
    const verifier = await verifierEmployee(db);
    await verifyInvoice(db, invoice.id, verifier.employee_id);
    const rejecter = await designatedApproverMember(db, 'Designated Rejecter');

    await expect(rejectInvoice(db, invoice.id, rejecter.member_id, '')).rejects.toThrow(InvoiceValidationError);

    const stillVerified = await getInvoice(db, invoice.id);
    expect(stillVerified!.status).toBe('verified');
  });
});

// A genuine Promise.allSettled race against this engine is unreliable:
// PGliteEngine is single-connection and its own docstring warns concurrent
// beginTransaction() calls interleave on that one connection rather than
// serialize (confirmed here -- both sides "succeeded" every trial, since the
// interleaved BEGINs share one session's transaction/lock context instead of
// two isolated ones). Same precedent as test/assets/ownerships-api.test.ts's
// "a second sequential createOwnership" test and test/finance/reversal.test.ts's
// own reversal race: production runs on DataApiEngine, not PGliteEngine, so
// each trial instead drives the two paths sequentially, alternating which
// one goes first, proving the mutual-exclusion guard holds in both orderings
// (AC3) -- the loser always sees InvoiceConflictError from the point the
// winner commits.
describe('STR-084 T-P1 (property, TC-VEN-026/027) -- override-vs-resubmission mutual exclusion holds in both orderings', () => {
  it('exactly one of {override reaching approved, resubmission} ever succeeds, whichever runs first', async () => {
    const TRIALS = 16;

    for (let trial = 0; trial < TRIALS; trial++) {
      const db = await freshMigratedDb();
      const bucket = freshBucket();
      const invoice = await submittedInvoice(db, bucket);
      const verifier = await verifierEmployee(db);
      await verifyInvoice(db, invoice.id, verifier.employee_id);

      const rejecter = await designatedApproverMember(db, `Rejecter ${trial}`);
      const ecOne = await ecMember(db, `EC One ${trial}`);
      const ecTwo = await ecMember(db, `EC Two ${trial}`);
      await rejectInvoice(db, invoice.id, rejecter.member_id, `Trial ${trial} rejection`);

      // One override vote already cast -- one vote short of majority(3) = 2.
      await recordOverrideApproval(db, invoice.id, ecOne.member_id);
      await bucket.put(`invoices/inv-race-${trial}.pdf`, 'race resubmission scan');

      const overrideFirst = trial % 2 === 0;

      if (overrideFirst) {
        const overridden = await recordOverrideApproval(db, invoice.id, ecTwo.member_id);
        expect(overridden.invoice.status).toBe('approved');

        await expect(
          submitInvoice(db, bucket, invoice.workOrderId, {
            amount: '2000.00',
            invoiceDate: '2026-07-12',
            documentId: `invoices/inv-race-${trial}.pdf`,
            resubmissionOf: invoice.id,
          }),
        ).rejects.toThrow(InvoiceConflictError);

        const finalInvoice = await getInvoice(db, invoice.id);
        expect(finalInvoice!.status).toBe('approved');
        expect(finalInvoice!.resubmittedAs).toBeNull();
      } else {
        const { invoice: resubmitted } = await submitInvoice(db, bucket, invoice.workOrderId, {
          amount: '2000.00',
          invoiceDate: '2026-07-12',
          documentId: `invoices/inv-race-${trial}.pdf`,
          resubmissionOf: invoice.id,
        });
        expect(resubmitted.resubmissionOf).toBe(invoice.id);

        await expect(recordOverrideApproval(db, invoice.id, ecTwo.member_id)).rejects.toThrow(InvoiceConflictError);

        const finalInvoice = await getInvoice(db, invoice.id);
        expect(finalInvoice!.status).toBe('rejected');
        expect(finalInvoice!.resubmittedAs).toBe(resubmitted.id);
      }
    }
  }, 60000);
});

// STR-083: two-phase invoice sign-off, sitting on top of STR-082's
// invoices.ts -- verifyInvoice (submitted -> verified, gated on the
// designated-verifier capability at the HTTP layer) and recordApproval
// (verified -> approved once a majority of the designated EC subset
// accumulates, gated on designated-approver). Kept testable with a plain
// Database, no HTTP dispatch required (test/vendors/invoice-approvals.test.ts).
// The EC-override/rejected-phase branch of recordApproval is STR-084's job,
// not this file's -- see recordApproval's own comment.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, Transaction } from '@aws-blocks/blocks';
import { getInvoice, InvoiceConflictError, type Invoice } from './invoices';
import { EC_OFFICES } from '../members/role-assignments';
import { pgTextArray } from '../sql-array';

/**
 * The live count of members currently holding the designated-approver EC
 * subset -- an open EC-office role_assignment (EC_OFFICES) joined against a
 * capability_approver_designations row, the same join capabilities.ts's
 * buildClaims does per-member, aggregated here. No hardcoded person/role:
 * both the subset and its size are derived live from STR-044's own
 * configuration (Definition of Done).
 */
export async function designatedApproverCount(db: Database | Transaction): Promise<number> {
  const row = await db.queryOne<{ count: number }>(
    sql`SELECT COUNT(*)::int AS count
        FROM capability_approver_designations cad
        JOIN role_assignments ra ON ra.member_id = cad.member_id
        WHERE ra.effective_to IS NULL AND ra.role = ANY(${pgTextArray(EC_OFFICES)}::text[])`,
  );
  return row!.count;
}

/** More than half of `count` (Governance & Roles' 2026-07-20 decision;
 * worked example: 5 designated approvers -> majority 3). */
export function majorityThreshold(count: number): number {
  return Math.floor(count / 2) + 1;
}

/**
 * `POST /invoices/{invoiceId}/verify` business logic (AC1: only a
 * `submitted` invoice can move to `verified`; AC4: impossible outside that
 * state, 409). The status check and the guarded UPDATE run inside one
 * transaction under a `SELECT ... FOR UPDATE` lock on the invoice row --
 * the same TOCTOU discipline STR-082's submitInvoice/amendWorkOrder
 * established, so a concurrent verify/approve on the same invoice can't
 * interleave with this one.
 */
export async function verifyInvoice(
  db: Database,
  invoiceId: string,
  actorEmployeeId: string,
  notes?: string | null,
): Promise<Invoice> {
  await db.transaction(async tx => {
    const locked = await tx.queryOne<{ status: string }>(sql`SELECT status FROM invoices WHERE id = ${invoiceId} FOR UPDATE`);
    if (!locked) {
      throw new InvoiceConflictError(`Invoice ${invoiceId} does not exist.`);
    }
    if (locked.status !== 'submitted') {
      throw new InvoiceConflictError(`Invoice ${invoiceId} is ${locked.status}; only a submitted invoice can be verified.`);
    }

    await tx.execute(sql`UPDATE invoices SET status = 'verified' WHERE id = ${invoiceId} AND status = 'submitted'`);
    await tx.execute(
      sql`INSERT INTO invoice_events (id, invoice_id, action, actor_id, actor_type, notes)
          VALUES (${randomUUID()}, ${invoiceId}, 'verified', ${actorEmployeeId}, 'employee', ${notes ?? null})`,
    );
  });

  return (await getInvoice(db, invoiceId))!;
}

export interface RecordApprovalResult {
  invoice: Invoice;
  approvalProgress: { approvedCount: number; requiredCount: number };
}

/**
 * `POST /invoices/{invoiceId}/approve` business logic -- the `verified`-
 * phase branch only (AC2/AC3: approvals accumulate per distinct designated
 * approver until a live majority is crossed, at which point the invoice
 * flips to `approved` exactly once). The rejected-phase EC-override branch
 * the same OpenAPI operation also documents is STR-084's job, not this
 * function's -- any status other than `verified` (including `rejected`)
 * 409s here (AC4).
 *
 * The status check, the idempotent approval insert, the recount, and the
 * maybe-flip-to-approved UPDATE all run inside one transaction under a
 * `SELECT ... FOR UPDATE` lock on the invoice row, held for the whole
 * sequence -- not just a bare status check -- so two concurrent approvals on
 * the same invoice (whether from the same or different members) can't
 * interleave their read-recompute-write steps. Same TOCTOU discipline
 * STR-082's submitInvoice was fixed to use.
 */
export async function recordApproval(
  db: Database,
  invoiceId: string,
  actorMemberId: string,
  notes?: string | null,
): Promise<RecordApprovalResult> {
  let approvedCount = 0;
  let requiredCount = 0;

  await db.transaction(async tx => {
    const locked = await tx.queryOne<{ status: string }>(sql`SELECT status FROM invoices WHERE id = ${invoiceId} FOR UPDATE`);
    if (!locked) {
      throw new InvoiceConflictError(`Invoice ${invoiceId} does not exist.`);
    }
    if (locked.status !== 'verified') {
      throw new InvoiceConflictError(`Invoice ${invoiceId} is ${locked.status}; only a verified invoice can be approved.`);
    }

    // ON CONFLICT DO NOTHING -- the same idempotent-designation idiom
    // capabilities.ts's designateApprover already established (TC-VEN-023:
    // a repeat approval from the same member counts once).
    await tx.execute(
      sql`INSERT INTO invoice_approvals (id, invoice_id, member_id, is_override, notes)
          VALUES (${randomUUID()}, ${invoiceId}, ${actorMemberId}, false, ${notes ?? null})
          ON CONFLICT (invoice_id, member_id, is_override) DO NOTHING`,
    );

    const countRow = await tx.queryOne<{ count: number }>(
      sql`SELECT COUNT(DISTINCT member_id)::int AS count FROM invoice_approvals WHERE invoice_id = ${invoiceId} AND is_override = false`,
    );
    approvedCount = countRow!.count;
    requiredCount = majorityThreshold(await designatedApproverCount(tx));

    if (approvedCount >= requiredCount) {
      await tx.execute(sql`UPDATE invoices SET status = 'approved' WHERE id = ${invoiceId} AND status = 'verified'`);
      await tx.execute(
        sql`INSERT INTO invoice_events (id, invoice_id, action, actor_id, actor_type, notes)
            VALUES (${randomUUID()}, ${invoiceId}, 'approved', ${actorMemberId}, 'member', ${notes ?? null})`,
      );
    }
  });

  const invoice = await getInvoice(db, invoiceId);
  return { invoice: invoice!, approvalProgress: { approvedCount, requiredCount } };
}

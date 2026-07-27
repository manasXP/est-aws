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
import { getInvoice, InvoiceConflictError, InvoiceForbiddenError, InvoiceValidationError, type Invoice } from './invoices';
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
  // COUNT(DISTINCT cad.member_id), not COUNT(*): nothing stops a member
  // from simultaneously holding two different open EC offices (only same-
  // role double-holding is guarded, migrations/013's
  // role_assignments_open_unique), which would otherwise double-count them
  // against the join and inflate the majority threshold above a true
  // majority of the real distinct subset.
  const row = await db.queryOne<{ count: number }>(
    sql`SELECT COUNT(DISTINCT cad.member_id)::int AS count
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

    // Scoped to members who are STILL currently in the designated-approver
    // subset (the same join designatedApproverCount uses below), not a raw
    // historical count of every row ever inserted -- otherwise a member's
    // old, idempotent-no-op duplicate approval could resurface as "new"
    // consent purely because the live subset (and so the majority
    // threshold) shrank in between, letting an invoice flip to approved
    // with no new vote actually cast (a stale approval outliving the
    // approver's own EC tenure).
    const countRow = await tx.queryOne<{ count: number }>(
      sql`SELECT COUNT(DISTINCT ia.member_id)::int AS count
          FROM invoice_approvals ia
          JOIN capability_approver_designations cad ON cad.member_id = ia.member_id
          JOIN role_assignments ra ON ra.member_id = cad.member_id
          WHERE ia.invoice_id = ${invoiceId} AND ia.is_override = false
            AND ra.effective_to IS NULL AND ra.role = ANY(${pgTextArray(EC_OFFICES)}::text[])`,
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

/**
 * The live count of every member currently holding *any* EC office
 * (EC_OFFICES) -- the entire EC, unlike designatedApproverCount's above,
 * which is scoped to the narrower designated-approver subset joined against
 * capability_approver_designations. STR-084's override path supersedes a
 * rejection at a majority of this wider denominator (TC-VEN-025).
 */
export async function currentEcMemberCount(db: Database | Transaction): Promise<number> {
  const row = await db.queryOne<{ count: number }>(
    sql`SELECT COUNT(DISTINCT member_id)::int AS count
        FROM role_assignments
        WHERE effective_to IS NULL AND role = ANY(${pgTextArray(EC_OFFICES)}::text[])`,
  );
  return row!.count;
}

/** Whether `memberId` currently holds an open assignment for any EC office
 * -- the any-EC-member authorization check STR-084's override path needs,
 * distinct from the narrower designated-approver capability. */
export async function isCurrentEcMember(db: Database | Transaction, memberId: string): Promise<boolean> {
  const row = await db.queryOne(
    sql`SELECT 1 FROM role_assignments
        WHERE member_id = ${memberId} AND effective_to IS NULL AND role = ANY(${pgTextArray(EC_OFFICES)}::text[])
        LIMIT 1`,
  );
  return row !== null;
}

/**
 * `POST /invoices/{invoiceId}/reject` business logic (TC-VEN-024: only a
 * `verified` invoice can be rejected, with a mandatory reason; the invoice
 * moves to `rejected` immediately and its prior accumulated approvals stop
 * counting toward any threshold the instant it leaves `verified` --
 * `invoice_approvals` stays append-only, per STR-083's own idiom, rather
 * than being deleted). Same row-lock discipline as verifyInvoice/
 * recordApproval above: the status check and the guarded UPDATE run inside
 * one transaction under a `SELECT ... FOR UPDATE` lock on the invoice row.
 *
 * No designated-approver capability check inside this function -- capability
 * gating is purely an HTTP-layer concern (requireCapability), mirroring
 * verifyInvoice/recordApproval's own precedent exactly.
 */
export async function rejectInvoice(
  db: Database,
  invoiceId: string,
  actorMemberId: string,
  reason: string,
): Promise<Invoice> {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new InvoiceValidationError('A reason is required to reject an invoice.');
  }

  await db.transaction(async tx => {
    const locked = await tx.queryOne<{ status: string }>(sql`SELECT status FROM invoices WHERE id = ${invoiceId} FOR UPDATE`);
    if (!locked) {
      throw new InvoiceConflictError(`Invoice ${invoiceId} does not exist.`);
    }
    if (locked.status !== 'verified') {
      throw new InvoiceConflictError(`Invoice ${invoiceId} is ${locked.status}; only a verified invoice can be rejected.`);
    }

    await tx.execute(sql`UPDATE invoices SET status = 'rejected' WHERE id = ${invoiceId} AND status = 'verified'`);
    await tx.execute(
      sql`INSERT INTO invoice_events (id, invoice_id, action, actor_id, actor_type, notes)
          VALUES (${randomUUID()}, ${invoiceId}, 'rejected', ${actorMemberId}, 'member', ${reason})`,
    );
  });

  return (await getInvoice(db, invoiceId))!;
}

/**
 * `POST /invoices/{invoiceId}/approve` business logic -- the `rejected`-
 * phase EC-override branch recordApproval above deliberately left for this
 * story (TC-VEN-025/026: any current EC office holder, not just the
 * designated-approver subset, votes to override a rejection; a majority of
 * the *entire* EC -- currentEcMemberCount, not designatedApproverCount --
 * supersedes the rejection and flips the invoice to `approved`).
 *
 * Guard order matters and must stay exactly as written: existence -> status/
 * resubmitted_as conflict (409, TC-VEN-026: a resubmission-closed override
 * window 409s even for a genuine EC member) -> EC-membership (403) -> insert
 * -> recount -> maybe-flip. Same row-lock discipline as recordApproval
 * above: the status check, the idempotent override-approval insert, the
 * recount, and the maybe-flip-to-approved UPDATE all run inside one
 * transaction under a `SELECT ... FOR UPDATE` lock on the invoice row.
 */
export async function recordOverrideApproval(
  db: Database,
  invoiceId: string,
  actorMemberId: string,
  notes?: string | null,
): Promise<RecordApprovalResult> {
  let approvedCount = 0;
  let requiredCount = 0;

  await db.transaction(async tx => {
    const locked = await tx.queryOne<{ status: string; resubmitted_as: string | null }>(
      sql`SELECT status, resubmitted_as FROM invoices WHERE id = ${invoiceId} FOR UPDATE`,
    );
    if (!locked) {
      throw new InvoiceConflictError(`Invoice ${invoiceId} does not exist.`);
    }
    if (locked.status !== 'rejected' || locked.resubmitted_as !== null) {
      throw new InvoiceConflictError(
        `Invoice ${invoiceId} is not open for EC override (status ${locked.status}${locked.resubmitted_as ? ', already resubmitted' : ''}).`,
      );
    }
    if (!(await isCurrentEcMember(tx, actorMemberId))) {
      throw new InvoiceForbiddenError(`Member ${actorMemberId} does not currently hold an EC office.`);
    }

    await tx.execute(
      sql`INSERT INTO invoice_approvals (id, invoice_id, member_id, is_override, notes)
          VALUES (${randomUUID()}, ${invoiceId}, ${actorMemberId}, true, ${notes ?? null})
          ON CONFLICT (invoice_id, member_id, is_override) DO NOTHING`,
    );

    // Same live-recount discipline as recordApproval above (STR-083 T-U8's
    // fix): only currently-open EC members' override votes count, so a vote
    // from a member who has since left the EC doesn't outlive their tenure.
    const countRow = await tx.queryOne<{ count: number }>(
      sql`SELECT COUNT(DISTINCT ia.member_id)::int AS count
          FROM invoice_approvals ia
          JOIN role_assignments ra ON ra.member_id = ia.member_id
          WHERE ia.invoice_id = ${invoiceId} AND ia.is_override = true
            AND ra.effective_to IS NULL AND ra.role = ANY(${pgTextArray(EC_OFFICES)}::text[])`,
    );
    approvedCount = countRow!.count;
    requiredCount = majorityThreshold(await currentEcMemberCount(tx));

    if (approvedCount >= requiredCount) {
      await tx.execute(sql`UPDATE invoices SET status = 'approved' WHERE id = ${invoiceId} AND status = 'rejected'`);
      await tx.execute(
        sql`INSERT INTO invoice_events (id, invoice_id, action, actor_id, actor_type, notes)
            VALUES (${randomUUID()}, ${invoiceId}, 'approved', ${actorMemberId}, 'member', ${notes ?? null})`,
      );
    }
  });

  const invoice = await getInvoice(db, invoiceId);
  return { invoice: invoice!, approvalProgress: { approvedCount, requiredCount } };
}

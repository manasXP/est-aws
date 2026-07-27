// STR-071: the raw gapless per-FY receipt number allocator (Finance &
// Compliance, receipts are "auto-numbered, gapless, per financial year, with
// a society prefix"). This is only the allocation primitive -- it does not
// format the final receipt string (STR-073), decide GST/plain shape
// (STR-075), or persist a receipt record (STR-079).
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, FileBucket, Transaction } from '@aws-blocks/blocks';
import { financialYearOf } from './financial-year';
import { getCurrentTreasurerName } from '../members/role-assignments';
import { parseMoney, formatMoney } from '../money';
import { linkDocumentToEntry, DocumentLinkError } from './documents';

/**
 * Atomically allocate the next integer in `fyLabel`'s receipt series,
 * inside the caller's own transaction so a caller that rolls back consumes
 * no number. First allocation for a new FY label returns 1.
 *
 * The `INSERT ... ON CONFLICT (fy_label) DO UPDATE ... RETURNING` upsert
 * below is the standard race-free idiom for a gapless counter under a real
 * Postgres connection pool (the production `PgClientEngine`). Note,
 * however, that this repo's local test suite (test/finance/receipts.test.ts
 * T-P1) runs against the `@aws-blocks/bb-data` PGlite-backed Database mock,
 * which serializes all work over a single shared connection -- concurrent
 * `db.transaction()` calls there merge into one open transaction rather
 * than exercising independent, isolated sessions. So T-P1 only demonstrates
 * gaplessness/no-duplication across allocations that all commit; it cannot
 * demonstrate this upsert's cross-connection atomicity under concurrent
 * load against real Postgres, which is unverified by this local suite.
 */
export async function allocateReceiptSeriesNumber(tx: Transaction, fyLabel: string): Promise<number> {
  const row = await tx.queryOne<{ allocated: number }>(
    sql`INSERT INTO receipt_series_counters (fy_label, next_number) VALUES (${fyLabel}, 2)
        ON CONFLICT (fy_label) DO UPDATE SET next_number = receipt_series_counters.next_number + 1
        RETURNING next_number - 1 AS allocated`,
  );
  return row!.allocated;
}

/**
 * STR-073: formats a receipt number as `<prefix>/<fy-label>/<counter>`, e.g.
 * `SOC/2026-27/000001`. `issuedOnDate` is resolved to its **IST calendar
 * date** via `AT TIME ZONE 'Asia/Kolkata'` before being fed to
 * `financialYearOf` -- the same idiom STR-024 established for FY bucketing
 * (aws-blocks/finance/books.ts, aws-blocks/members/members-api.ts) -- so a
 * receipt issued in the UTC evening of Mar 31 that is already IST Apr 1
 * lands in the new FY, not the old one.
 *
 * All reads run against the caller's own `tx` -- the date resolution has no
 * correctness reason to hold a second pool connection outside the
 * transaction that's about to allocate the counter.
 *
 * Throws if `society_settings.receipt_prefix` hasn't been configured yet
 * (still the migration's placeholder `''`): silently minting a
 * prefix-less, auditor-facing statutory receipt number is worse than
 * failing loudly before anything is written.
 */
export async function formatReceiptNumber(tx: Transaction, issuedOnDate: string): Promise<string> {
  const dateRow = await tx.queryOne<{ ist_date: string }>(
    sql`SELECT (${issuedOnDate}::timestamptz AT TIME ZONE 'Asia/Kolkata')::date::text AS ist_date`,
  );
  const fy = financialYearOf(dateRow!.ist_date);

  const allocated = await allocateReceiptSeriesNumber(tx, fy.label);

  const settings = await tx.queryOne<{ receipt_prefix: string }>(
    sql`SELECT receipt_prefix FROM society_settings WHERE id = 'default'`,
  );
  if (!settings!.receipt_prefix) {
    throw new Error('society_settings.receipt_prefix is not configured -- set it before issuing receipts.');
  }

  return `${settings!.receipt_prefix}/${fy.label}/${String(allocated).padStart(6, '0')}`;
}

/**
 * STR-075: the shape of receipt fields to print, driven solely by whether
 * `society_settings.gstin` is configured -- no per-transaction threshold
 * check. Unregistered societies (`gstin` NULL) get the plain shape;
 * GST-registered ones get the `gst` shape carrying the GSTIN and the
 * currently-open Treasurer's printed name (STR-041) -- no signature image
 * in v1. The `gst` branch also carries the tax-line amounts computed by
 * `computeGstTaxLines` (STR-077). Does not persist a receipt record
 * (STR-079).
 */
export type ReceiptFormat =
  | { kind: 'plain' }
  | { kind: 'gst'; gstin: string; treasurerName: string | null; taxableAmount: string; cgstAmount: string; sgstAmount: string };

export async function buildReceiptFormat(db: Transaction, totalAmount: string): Promise<ReceiptFormat> {
  const settings = await db.queryOne<{ gstin: string | null }>(
    sql`SELECT gstin FROM society_settings WHERE id = 'default'`,
  );
  const gstin = settings?.gstin;
  if (!gstin) {
    return { kind: 'plain' };
  }

  const treasurerName = await getCurrentTreasurerName(db);
  const { taxableAmount, cgstAmount, sgstAmount } = computeGstTaxLines(parseMoney(totalAmount));
  return {
    kind: 'gst',
    gstin,
    treasurerName,
    taxableAmount: formatMoney(taxableAmount),
    cgstAmount: formatMoney(cgstAmount),
    sgstAmount: formatMoney(sgstAmount),
  };
}

/**
 * STR-077: back-calculates a GST-inclusive receipt total into its taxable
 * value + CGST + SGST tax lines. This deployment is single-state,
 * single-society (CLAUDE.md invariant), so every receipt is an intra-state
 * supply: standard flat 18% GST, split evenly as 9% CGST + 9% SGST. Integer
 * bigint-paise arithmetic only -- no float ever touches this computation.
 *
 * Any single leftover paisa from the rounding remainder is folded into
 * `taxableAmount`, never into `cgstAmount`/`sgstAmount` -- so the tax split
 * itself is always exactly even (AC2), and the three lines always sum to
 * `totalPaise` exactly (AC1).
 */
export function computeGstTaxLines(totalPaise: bigint): { taxableAmount: bigint; cgstAmount: bigint; sgstAmount: bigint } {
  const scaled = totalPaise * 100n;
  const q = scaled / 118n;
  const r = scaled % 118n;
  let taxableAmount = r * 2n >= 118n ? q + 1n : q;

  const taxTotal = totalPaise - taxableAmount;
  const half = taxTotal / 2n;
  const leftover = taxTotal - half * 2n;
  const cgstAmount = half;
  const sgstAmount = half;

  taxableAmount = taxableAmount + leftover;

  return { taxableAmount, cgstAmount, sgstAmount };
}

export interface IssueReceiptResult {
  id: string;
  receiptNumber: string;
  fyLabel: string;
  entryId: string;
  amount: string;
  gstin: string | null;
  taxableAmount: string | null;
  cgstAmount: string | null;
  sgstAmount: string | null;
  treasurerName: string | null;
  documentPath: string;
  issuedAt: string;
}

/**
 * Assembles STR-071/073/075/077's number/format computations and STR-025's
 * document link into one persisted, ledger-linked receipt (AC1-AC4). The
 * entry-existence check runs first, before any counter allocation or
 * bucket write, so a bad entryId leaves nothing behind (AC4) -- the one
 * exception is that a FileBucket `put` is not part of the SQL transaction
 * (FileBucket isn't a transactional resource), so atomicity is guaranteed
 * only up through that first check; nothing after it is expected to fail
 * in practice (receipt_number is freshly allocated, entryId was just
 * verified).
 */
export async function issueReceipt(
  db: Database,
  bucket: FileBucket,
  entryId: string,
  amount: string,
): Promise<IssueReceiptResult> {
  return db.transaction(async tx => {
    const entry = await tx.queryOne(sql`SELECT id FROM journal_entries WHERE id = ${entryId}`);
    if (!entry) {
      throw new DocumentLinkError(`No journal entry found with id: ${entryId}`, 'entry_not_found');
    }

    const receiptNumber = await formatReceiptNumber(tx, new Date().toISOString());
    // formatReceiptNumber's own contract (see its docstring above): "<prefix>/<fy-label>/<counter>".
    const [, fyLabel, counter] = receiptNumber.split('/');
    const format = await buildReceiptFormat(tx, amount);

    const documentPath = `receipts/${fyLabel}/${counter}.txt`;
    const lines = [
      `Receipt Number: ${receiptNumber}`,
      `Financial Year: ${fyLabel}`,
      `Entry ID: ${entryId}`,
      `Amount: ${amount}`,
    ];
    if (format.kind === 'gst') {
      lines.push(
        `GSTIN: ${format.gstin}`,
        `Taxable Amount: ${format.taxableAmount}`,
        `CGST: ${format.cgstAmount}`,
        `SGST: ${format.sgstAmount}`,
        `Treasurer: ${format.treasurerName ?? ''}`,
      );
    }
    await bucket.put(documentPath, lines.join('\n'), { contentType: 'text/plain' });

    await linkDocumentToEntry(tx, bucket, entryId, documentPath);

    const gstin = format.kind === 'gst' ? format.gstin : null;
    const taxableAmount = format.kind === 'gst' ? format.taxableAmount : null;
    const cgstAmount = format.kind === 'gst' ? format.cgstAmount : null;
    const sgstAmount = format.kind === 'gst' ? format.sgstAmount : null;
    const treasurerName = format.kind === 'gst' ? format.treasurerName : null;

    const row = await tx.queryOne<{ id: string; issued_at: string }>(
      sql`INSERT INTO receipts (id, receipt_number, fy_label, entry_id, amount, gstin, taxable_amount, cgst_amount, sgst_amount, treasurer_name, document_path)
          VALUES (${randomUUID()}, ${receiptNumber}, ${fyLabel}, ${entryId}, ${amount}, ${gstin}, ${taxableAmount}, ${cgstAmount}, ${sgstAmount}, ${treasurerName}, ${documentPath})
          RETURNING id, issued_at::text AS issued_at`,
    );

    return {
      id: row!.id,
      receiptNumber,
      fyLabel,
      entryId,
      amount,
      gstin,
      taxableAmount,
      cgstAmount,
      sgstAmount,
      treasurerName,
      documentPath,
      issuedAt: row!.issued_at,
    };
  });
}

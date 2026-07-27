// STR-071: the raw gapless per-FY receipt number allocator (Finance &
// Compliance, receipts are "auto-numbered, gapless, per financial year, with
// a society prefix"). This is only the allocation primitive -- it does not
// format the final receipt string (STR-073), decide GST/plain shape
// (STR-075), or persist a receipt record (STR-079).
import { sql } from '@aws-blocks/blocks';
import type { Database, Transaction } from '@aws-blocks/blocks';
import { financialYearOf } from './financial-year';
import { getCurrentTreasurerName } from '../members/role-assignments';
import { parseMoney, formatMoney } from '../money';

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
 * in v1. Does not compute GST tax-line amounts (STR-077) or persist a
 * receipt record (STR-079).
 */
export type ReceiptFormat =
  | { kind: 'plain' }
  | { kind: 'gst'; gstin: string; treasurerName: string | null; taxableAmount: string; cgstAmount: string; sgstAmount: string };

export async function buildReceiptFormat(db: Database, totalAmount: string): Promise<ReceiptFormat> {
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

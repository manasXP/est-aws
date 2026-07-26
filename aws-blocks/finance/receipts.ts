// STR-071: the raw gapless per-FY receipt number allocator (Finance &
// Compliance, receipts are "auto-numbered, gapless, per financial year, with
// a society prefix"). This is only the allocation primitive -- it does not
// format the final receipt string (STR-073), decide GST/plain shape
// (STR-075), or persist a receipt record (STR-079).
import { sql } from '@aws-blocks/blocks';
import type { Transaction } from '@aws-blocks/blocks';

/**
 * Atomically allocate the next integer in `fyLabel`'s receipt series,
 * inside the caller's own transaction so a caller that rolls back consumes
 * no number. First allocation for a new FY label returns 1.
 */
export async function allocateReceiptSeriesNumber(tx: Transaction, fyLabel: string): Promise<number> {
  const row = await tx.queryOne<{ allocated: number }>(
    sql`INSERT INTO receipt_series_counters (fy_label, next_number) VALUES (${fyLabel}, 2)
        ON CONFLICT (fy_label) DO UPDATE SET next_number = receipt_series_counters.next_number + 1
        RETURNING next_number - 1 AS allocated`,
  );
  return row!.allocated;
}

// STR-022: reversing-entry corrections (Finance & Compliance, "Ledger
// entries are append-only with an audit trail; corrections are reversing
// entries, not edits."). A reversal is a new, ordinary balanced posting
// (via STR-021's postJournalEntry) whose lines mirror the original with
// every direction flipped — that keeps it balanced automatically, since the
// original was balanced — linked back to the original via
// `reverses_entry_id`. The original is never touched: migration 002's
// immutability trigger guarantees that even in principle, but this service
// only ever INSERTs, never UPDATEs.
import { DatabaseErrors, isBlocksError, sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { JournalError, postJournalEntry, type CounterpartyType, type PostingDirection, type PostingLine } from './journal';

export interface ReverseJournalEntryResult {
  entryId: string;
}

const OPPOSITE_DIRECTION: Record<PostingDirection, PostingDirection> = {
  debit: 'credit',
  credit: 'debit',
};

/**
 * Reverse a posted journal entry: builds a mirror posting with every line's
 * direction flipped (same account/amount) and writes it linked to the
 * original via `reverses_entry_id`. Rejects — writing nothing — if the
 * original entry doesn't exist, or if it has already been reversed (T-U3:
 * an entry cannot be reversed twice).
 */
export async function reverseJournalEntry(
  db: Database,
  entryId: string,
  description: string,
): Promise<ReverseJournalEntryResult> {
  const originalLines = await db.query<{
    account_id: string;
    direction: PostingDirection;
    amount: string;
    counterparty_type: CounterpartyType | null;
    counterparty_id: string | null;
  }>(
    sql`SELECT account_id, direction, amount, counterparty_type, counterparty_id FROM journal_lines WHERE entry_id = ${entryId}`,
  );
  if (originalLines.length === 0) {
    const original = await db.queryOne(sql`SELECT id FROM journal_entries WHERE id = ${entryId}`);
    if (!original) {
      throw new JournalError(`No journal entry found with id: ${entryId}`);
    }
  }

  const existingReversal = await db.queryOne(
    sql`SELECT id FROM journal_entries WHERE reverses_entry_id = ${entryId}`,
  );
  if (existingReversal) {
    throw new JournalError(`Journal entry ${entryId} has already been reversed.`);
  }

  const mirroredLines: PostingLine[] = originalLines.map(line => ({
    accountId: line.account_id,
    direction: OPPOSITE_DIRECTION[line.direction],
    amount: line.amount,
    counterpartyType: line.counterparty_type ?? undefined,
    counterpartyId: line.counterparty_id ?? undefined,
  }));

  try {
    const { entryId: reversalEntryId } = await postJournalEntry(db, description, mirroredLines, {
      reversesEntryId: entryId,
    });
    return { entryId: reversalEntryId };
  } catch (e: unknown) {
    // migrations/003_reversal_uniqueness.sql backstops the SELECT check
    // above against the TOCTOU race between two concurrent reversals of the
    // same entry: if both pass that check before either commits, one of the
    // two INSERTs here hits the partial unique index and lands here instead
    // of succeeding.
    if (isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)) {
      throw new JournalError(`Journal entry ${entryId} has already been reversed.`);
    }
    throw e;
  }
}

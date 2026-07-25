// STR-021: the posting writer for the single append-only double-entry
// journal (Finance & Compliance, "Decisions 2026-07-20"). Validates before
// writing anything, then writes the entry header + its lines atomically.
// There is no update/delete path anywhere in this module — corrections are
// reversing entries (STR-022, see finance/reversal.ts), never edits.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { moneyEquals, parseMoney, sumMoney } from '../money';

export type PostingDirection = 'debit' | 'credit';

/** STR-023: which book projection (Payment/Expense Ledger) a line belongs to. */
export type CounterpartyType = 'member' | 'vendor' | 'payee';

export interface PostingLine {
  accountId: string;
  direction: PostingDirection;
  amount: string;
  /**
   * STR-023: optional classification tag for the Payment/Expense Ledger
   * book projections (aws-blocks/finance/books.ts) — 'member' for Payment
   * Ledger, 'vendor'/'payee' for Expense Ledger. Not a foreign key: no
   * member/vendor/employee registry exists yet, so this is opaque metadata.
   * Backward compatible — omitted entirely by callers with no counterparty.
   */
  counterpartyType?: CounterpartyType;
  counterpartyId?: string;
}

export interface PostJournalEntryResult {
  entryId: string;
}

export interface PostJournalEntryOptions {
  /** STR-022: links this posting back to the entry it reverses, if any. */
  reversesEntryId?: string;
  /**
   * STR-024: overrides the column default of `now()`. Only needed by tests
   * asserting FY-period filtering at specific dates (aws-blocks/finance/
   * books-api.ts) — production callers omit it and get the posting instant.
   */
  postedAt?: string;
}

/** Domain rejection for an invalid posting — nothing is written when this is thrown. */
export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalError';
  }
}

/**
 * Write a balanced double-entry posting: a `journal_entries` header plus its
 * `journal_lines`, atomically. Rejects — writing nothing — if any referenced
 * ledger account doesn't exist (AC4), or if debits don't equal credits
 * exactly using decimal-string comparison (AC1, TC-FIN-002).
 */
export async function postJournalEntry(
  db: Database,
  description: string,
  lines: readonly PostingLine[],
  options: PostJournalEntryOptions = {},
): Promise<PostJournalEntryResult> {
  if (lines.length === 0) {
    throw new JournalError('A journal entry needs at least one line.');
  }

  const nonPositive = lines.filter(line => parseMoney(line.amount) <= 0n);
  if (nonPositive.length > 0) {
    throw new JournalError(`Journal line amounts must be positive: ${nonPositive.map(line => line.amount).join(', ')}`);
  }

  const referencedAccountIds = [...new Set(lines.map(line => line.accountId))];
  const accounts = await db.query<{ id: string }>(
    sql`SELECT id FROM ledger_accounts WHERE id = ANY(${referencedAccountIds})`,
  );
  const knownAccountIds = new Set(accounts.map(row => row.id));
  const missing = referencedAccountIds.filter(id => !knownAccountIds.has(id));
  if (missing.length > 0) {
    throw new JournalError(`Unknown ledger account(s): ${missing.join(', ')}`);
  }

  const debitTotal = sumMoney(lines.filter(line => line.direction === 'debit').map(line => line.amount));
  const creditTotal = sumMoney(lines.filter(line => line.direction === 'credit').map(line => line.amount));
  if (!moneyEquals(debitTotal, creditTotal)) {
    throw new JournalError(`Unbalanced posting: debits ${debitTotal} != credits ${creditTotal}`);
  }

  const entryId = randomUUID();
  await db.transaction(async tx => {
    await tx.execute(
      options.postedAt
        ? sql`INSERT INTO journal_entries (id, description, reverses_entry_id, posted_at)
              VALUES (${entryId}, ${description}, ${options.reversesEntryId ?? null}, ${options.postedAt})`
        : sql`INSERT INTO journal_entries (id, description, reverses_entry_id)
              VALUES (${entryId}, ${description}, ${options.reversesEntryId ?? null})`,
    );
    for (const line of lines) {
      await tx.execute(
        sql`INSERT INTO journal_lines (id, entry_id, account_id, direction, amount, counterparty_type, counterparty_id)
            VALUES (${randomUUID()}, ${entryId}, ${line.accountId}, ${line.direction}, ${line.amount}, ${line.counterpartyType ?? null}, ${line.counterpartyId ?? null})`,
      );
    }
  });

  return { entryId };
}

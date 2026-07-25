// STR-021: the posting writer for the single append-only double-entry
// journal (Finance & Compliance, "Decisions 2026-07-20"). Validates before
// writing anything, then writes the entry header + its lines atomically.
// There is no update/delete path anywhere in this module — corrections are
// reversing entries (a later story), never edits.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { moneyEquals, sumMoney } from '../money';

export type PostingDirection = 'debit' | 'credit';

export interface PostingLine {
  accountId: string;
  direction: PostingDirection;
  amount: string;
}

export interface PostJournalEntryResult {
  entryId: string;
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
): Promise<PostJournalEntryResult> {
  if (lines.length === 0) {
    throw new JournalError('A journal entry needs at least one line.');
  }

  const accounts = await db.query<{ id: string }>(sql`SELECT id FROM ledger_accounts`);
  const knownAccountIds = new Set(accounts.map(row => row.id));
  const missing = [...new Set(lines.map(line => line.accountId))].filter(id => !knownAccountIds.has(id));
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
    await tx.execute(sql`INSERT INTO journal_entries (id, description) VALUES (${entryId}, ${description})`);
    for (const line of lines) {
      await tx.execute(
        sql`INSERT INTO journal_lines (id, entry_id, account_id, direction, amount)
            VALUES (${randomUUID()}, ${entryId}, ${line.accountId}, ${line.direction}, ${line.amount})`,
      );
    }
  });

  return { entryId };
}

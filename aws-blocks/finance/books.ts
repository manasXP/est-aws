// STR-023: the four books of account (Finance & Compliance, "Decisions
// 2026-07-20") as derived views over the single append-only journal — never
// separately maintained stores. Book membership is two independent axes on
// a journal line, not mutually exclusive:
//   - Bank Book / Cash Book: which `ledger_accounts.kind` the line's
//     account resolves to ('bank' or 'cash').
//   - Payment Ledger / Expense Ledger: the line's `counterparty_type`
//     ('member' -> Payment Ledger; 'vendor'/'payee' -> Expense Ledger).
// A single line can appear in both a bank/cash book AND a counterparty
// ledger at once (TC-FIN-005, TC-FIN-007: "one posting, both projections").
// This module names the classification rules once — E11's Tally day-book
// export and E08's receipt issuance will key on the same rules.
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import type { CounterpartyType, PostingDirection } from './journal';

export interface BookEntry {
  line_id: string;
  entry_id: string;
  account_id: string;
  direction: PostingDirection;
  amount: string;
  description: string;
  /**
   * STR-024: rendered via `AT TIME ZONE 'Asia/Kolkata'` — an IST-local
   * `YYYY-MM-DD HH:MI:SS` text, not the UTC storage of the TIMESTAMPTZ
   * column, so books-api.ts's `entry_date`/FY-window date math (an
   * IST-calendar concept) is correct.
   */
  posted_at: string;
  counterparty_type: CounterpartyType | null;
  counterparty_id: string | null;
  /** STR-024: set on reversing entries — read straight off journal_entries. */
  reverses_entry_id: string | null;
}

/** STR-024: the four `book` path-param values the Admin API read surface accepts. */
export type BookName = 'bank' | 'cash' | 'payment' | 'expense';

/** Bank Book: postings touching a `ledger_accounts.kind = 'bank'` account. */
export async function getBankBookEntries(db: Database): Promise<BookEntry[]> {
  return db.query<BookEntry>(
    sql`SELECT jl.id AS line_id, jl.entry_id, jl.account_id, jl.direction, jl.amount,
               je.description, (je.posted_at AT TIME ZONE 'Asia/Kolkata')::text AS posted_at, je.reverses_entry_id,
               jl.counterparty_type, jl.counterparty_id
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN ledger_accounts la ON la.id = jl.account_id
        WHERE la.kind = 'bank'`,
  );
}

/** Cash Book: postings touching a `ledger_accounts.kind = 'cash'` account. */
export async function getCashBookEntries(db: Database): Promise<BookEntry[]> {
  return db.query<BookEntry>(
    sql`SELECT jl.id AS line_id, jl.entry_id, jl.account_id, jl.direction, jl.amount,
               je.description, (je.posted_at AT TIME ZONE 'Asia/Kolkata')::text AS posted_at, je.reverses_entry_id,
               jl.counterparty_type, jl.counterparty_id
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        JOIN ledger_accounts la ON la.id = jl.account_id
        WHERE la.kind = 'cash'`,
  );
}

/**
 * Payment Ledger: member-side postings (charges raised, payments received),
 * optionally filtered to a single member.
 */
export async function getPaymentLedgerEntries(db: Database, memberId?: string): Promise<BookEntry[]> {
  if (memberId !== undefined) {
    return db.query<BookEntry>(
      sql`SELECT jl.id AS line_id, jl.entry_id, jl.account_id, jl.direction, jl.amount,
                 je.description, (je.posted_at AT TIME ZONE 'Asia/Kolkata')::text AS posted_at, je.reverses_entry_id,
                 jl.counterparty_type, jl.counterparty_id
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE jl.counterparty_type = 'member' AND jl.counterparty_id = ${memberId}`,
    );
  }
  return db.query<BookEntry>(
    sql`SELECT jl.id AS line_id, jl.entry_id, jl.account_id, jl.direction, jl.amount,
               je.description, (je.posted_at AT TIME ZONE 'Asia/Kolkata')::text AS posted_at, je.reverses_entry_id,
               jl.counterparty_type, jl.counterparty_id
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.counterparty_type = 'member'`,
  );
}

/**
 * Expense Ledger: society-side outflow postings (vendor invoices, employee
 * salaries, other expenses — counterparty types 'vendor' and 'payee'),
 * optionally filtered to a single counterparty.
 */
export async function getExpenseLedgerEntries(db: Database, counterpartyId?: string): Promise<BookEntry[]> {
  if (counterpartyId !== undefined) {
    return db.query<BookEntry>(
      sql`SELECT jl.id AS line_id, jl.entry_id, jl.account_id, jl.direction, jl.amount,
                 je.description, (je.posted_at AT TIME ZONE 'Asia/Kolkata')::text AS posted_at, je.reverses_entry_id,
                 jl.counterparty_type, jl.counterparty_id
          FROM journal_lines jl
          JOIN journal_entries je ON je.id = jl.entry_id
          WHERE jl.counterparty_type IN ('vendor', 'payee') AND jl.counterparty_id = ${counterpartyId}`,
    );
  }
  return db.query<BookEntry>(
    sql`SELECT jl.id AS line_id, jl.entry_id, jl.account_id, jl.direction, jl.amount,
               je.description, (je.posted_at AT TIME ZONE 'Asia/Kolkata')::text AS posted_at, je.reverses_entry_id,
               jl.counterparty_type, jl.counterparty_id
        FROM journal_lines jl
        JOIN journal_entries je ON je.id = jl.entry_id
        WHERE jl.counterparty_type IN ('vendor', 'payee')`,
  );
}

/** STR-024: resolves the Admin API's `book` path param to the matching book-projection query, unfiltered by counterparty. */
export async function getBookEntries(db: Database, book: BookName): Promise<BookEntry[]> {
  switch (book) {
    case 'bank':
      return getBankBookEntries(db);
    case 'cash':
      return getCashBookEntries(db);
    case 'payment':
      return getPaymentLedgerEntries(db);
    case 'expense':
      return getExpenseLedgerEntries(db);
  }
}

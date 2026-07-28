// STR-101: the ledger-masters half of E11's Tally export (Finance &
// Compliance, "day-book vouchers as Tally-importable XML... plus the
// ledger masters needed to import them. No full chart-of-accounts sync").
// Tally rejects a voucher referencing a ledger it doesn't already know
// about, so the export needs exactly the `ledger_accounts` rows actually
// referenced by `journal_lines` whose posting falls inside the requested
// period — never the full table (that would be chart-of-accounts sync,
// explicitly out of scope). The period boundary matches STR-024's
// IST-calendar-date convention, not raw UTC.
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import type { PostingDirection } from './journal';

export interface LedgerAccount {
  id: string;
  name: string;
  kind: string;
}

/** One `journal_lines` row, plus its parent entry's header fields and its account's masters fields. */
interface JournalPostingRow {
  entry_id: string;
  description: string;
  /** IST calendar date (YYYY-MM-DD) of the entry's `posted_at` -- computed once here, never re-derived from a UTC timestamp in JS. */
  ist_date: string;
  line_id: string;
  account_id: string;
  account_name: string;
  account_kind: string;
  direction: PostingDirection;
  amount: string;
}

/**
 * STR-101/STR-102: the single query joining `journal_entries` +
 * `journal_lines` + `ledger_accounts`, scoped to the IST-calendar-date
 * period window `[from, to]` (STR-024's convention: `(posted_at AT TIME
 * ZONE 'Asia/Kolkata')::date BETWEEN`, never raw UTC) -- both
 * `getLedgerAccountsForPeriod` (STR-101) and `getPostingsInPeriod`
 * (STR-102) build on this one query rather than each duplicating the
 * predicate. The `sql` tag has no fragment-composition support (any `${}`
 * interpolation -- even of another query object -- becomes an opaque bound
 * parameter, never literal SQL text; see assets-api.ts's own note on this
 * same limitation), so sharing happens by having both callers reuse this
 * one query's rows, not by splicing WHERE-clause text across two queries.
 * One row per `journal_lines` row, ordered by `posted_at` then `jl.id` for
 * a deterministic, stable result.
 */
async function getJournalPostingRowsInPeriod(db: Database, from: string, to: string): Promise<JournalPostingRow[]> {
  return db.query<JournalPostingRow>(
    sql`SELECT je.id AS entry_id, je.description,
               (je.posted_at AT TIME ZONE 'Asia/Kolkata')::date::text AS ist_date,
               jl.id AS line_id, jl.account_id, la.name AS account_name, la.kind AS account_kind,
               jl.direction, jl.amount::text AS amount
        FROM journal_entries je
        JOIN journal_lines jl ON jl.entry_id = je.id
        JOIN ledger_accounts la ON la.id = jl.account_id
        WHERE (je.posted_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date
        ORDER BY je.posted_at, jl.id`,
  );
}

/**
 * The distinct ledger accounts referenced by journal postings whose
 * `posted_at` falls, on the IST calendar date, within `[from, to]`
 * (inclusive, YYYY-MM-DD). An account touched only outside the window is
 * excluded entirely — this is period filtering of referenced accounts, not
 * a chart-of-accounts sync.
 */
export async function getLedgerAccountsForPeriod(db: Database, from: string, to: string): Promise<LedgerAccount[]> {
  const rows = await getJournalPostingRowsInPeriod(db, from, to);
  const accountsById = new Map<string, LedgerAccount>();
  for (const row of rows) {
    if (!accountsById.has(row.account_id)) {
      accountsById.set(row.account_id, { id: row.account_id, name: row.account_name, kind: row.account_kind });
    }
  }
  return [...accountsById.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** One `<ALLLEDGERENTRIES.LIST>` line of a day-book voucher. */
export interface DayBookLine {
  accountId: string;
  accountName: string;
  direction: PostingDirection;
  amount: string;
}

/** One `journal_entries` posting, ready to become exactly one Tally `<VOUCHER>`. */
export interface Posting {
  entryId: string;
  description: string;
  /** IST calendar date (YYYY-MM-DD) of `posted_at`. */
  istDate: string;
  lines: DayBookLine[];
}

/**
 * STR-102: every `journal_entries` posting whose `posted_at` falls, on the
 * IST calendar date, within `[from, to]` (inclusive) -- each with its full
 * array of lines, grouped back from the flat rows of
 * `getJournalPostingRowsInPeriod`. Ordered by `posted_at` (via the shared
 * query) for a deterministic file; applies no special-casing to
 * `reverses_entry_id` -- a reversing entry is just another posting here.
 */
export async function getPostingsInPeriod(db: Database, from: string, to: string): Promise<Posting[]> {
  const rows = await getJournalPostingRowsInPeriod(db, from, to);
  const postingsByEntryId = new Map<string, Posting>();
  for (const row of rows) {
    let posting = postingsByEntryId.get(row.entry_id);
    if (!posting) {
      posting = { entryId: row.entry_id, description: row.description, istDate: row.ist_date, lines: [] };
      postingsByEntryId.set(row.entry_id, posting);
    }
    posting.lines.push({
      accountId: row.account_id,
      accountName: row.account_name,
      direction: row.direction,
      amount: row.amount,
    });
  }
  return [...postingsByEntryId.values()];
}

/** Documented fallback Tally parent group for any `ledger_accounts.kind` this table doesn't map. */
const DEFAULT_TALLY_PARENT_GROUP = 'Suspense';

/**
 * `ledger_accounts.kind` -> the Tally `<PARENT>` group a `<LEDGER>` master
 * imports under. A `Map`, not a plain object — a `kind` value that happens
 * to name an inherited `Object.prototype` member (e.g. `'constructor'`)
 * must still miss the lookup and fall back, not resolve to that inherited
 * value.
 */
export const TALLY_PARENT_GROUPS: ReadonlyMap<string, string> = new Map([
  ['cash', 'Cash-in-hand'],
  ['bank', 'Bank Accounts'],
]);

/** Resolves a `kind` to its Tally parent group, falling back to a documented default for an unmapped kind. */
export function tallyParentGroupFor(kind: string): string {
  return TALLY_PARENT_GROUPS.get(kind) ?? DEFAULT_TALLY_PARENT_GROUP;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Formats ledger accounts as a Tally `<LEDGER>` masters import document. */
export function buildLedgerMastersXml(accounts: readonly LedgerAccount[]): string {
  const ledgers = accounts
    .map(
      account => `<LEDGER NAME="${escapeXml(account.name)}" ACTION="Create">
<PARENT>${escapeXml(tallyParentGroupFor(account.kind))}</PARENT>
</LEDGER>`,
    )
    .join('\n');
  return `<ENVELOPE>
<IMPORTDATA>
<REQUESTDATA>
${ledgers}
</REQUESTDATA>
</IMPORTDATA>
</ENVELOPE>`;
}

/**
 * Formats postings as a Tally day-book `<VOUCHER VCHTYPE="Journal">` import
 * document -- one voucher per `journal_entries` row, exactly (AC1). This
 * codebase's journal has no Receipt/Payment voucher-type classification
 * (see the story's Context), so every voucher uses the generic `Journal`
 * type, which accepts any balanced debit/credit set.
 *
 * AMOUNT / ISDEEMEDPOSITIVE convention (no live Tally import has validated
 * this yet -- STR-104's spike is explicitly the place that will correct it
 * if wrong): a debit line's `<AMOUNT>` is negative and
 * `<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>`; a credit line's `<AMOUNT>` is
 * positive (unsigned) and `<ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>` --
 * mirroring Tally's own common journal-voucher import convention. Signing
 * is pure string prefixing (a leading `-` for debit), never numeric
 * negation -- `journal_lines.amount` is always stored/read as a positive
 * decimal string (`postJournalEntry` rejects non-positive lines), so no
 * arithmetic on the amount is needed at all (AC4).
 */
export function buildDayBookVouchersXml(postings: readonly Posting[]): string {
  const vouchers = postings
    .map(posting => {
      const date = posting.istDate.replace(/-/g, '');
      const ledgerEntries = posting.lines
        .map(
          line => `<ALLLEDGERENTRIES.LIST>
<LEDGERNAME>${escapeXml(line.accountName)}</LEDGERNAME>
<ISDEEMEDPOSITIVE>${line.direction === 'debit' ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
<AMOUNT>${line.direction === 'debit' ? `-${line.amount}` : line.amount}</AMOUNT>
</ALLLEDGERENTRIES.LIST>`,
        )
        .join('\n');
      return `<VOUCHER VCHTYPE="Journal" ACTION="Create">
<DATE>${date}</DATE>
<NARRATION>${escapeXml(posting.description)}</NARRATION>
${ledgerEntries}
</VOUCHER>`;
    })
    .join('\n');
  return `<ENVELOPE>
<IMPORTDATA>
<REQUESTDATA>
${vouchers}
</REQUESTDATA>
</IMPORTDATA>
</ENVELOPE>`;
}

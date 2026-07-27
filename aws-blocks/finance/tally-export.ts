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

export interface LedgerAccount {
  id: string;
  name: string;
  kind: string;
}

/**
 * The distinct ledger accounts referenced by journal postings whose
 * `posted_at` falls, on the IST calendar date, within `[from, to]`
 * (inclusive, YYYY-MM-DD). An account touched only outside the window is
 * excluded entirely — this is period filtering of referenced accounts, not
 * a chart-of-accounts sync.
 */
export async function getLedgerAccountsForPeriod(db: Database, from: string, to: string): Promise<LedgerAccount[]> {
  return db.query<LedgerAccount>(
    sql`SELECT DISTINCT la.id, la.name, la.kind
        FROM ledger_accounts la
        JOIN journal_lines jl ON jl.account_id = la.id
        JOIN journal_entries je ON je.id = jl.entry_id
        WHERE (je.posted_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN ${from}::date AND ${to}::date
        ORDER BY la.id`,
  );
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

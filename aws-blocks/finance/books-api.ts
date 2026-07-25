// STR-024: the Admin API book-read surface's business logic, sitting
// between the STR-023 book-projection queries (finance/books.ts) and the
// HTTP layer (finance/books-routes.ts) — kept separate so it's testable
// with a plain Database, no HTTP dispatch required (test/finance/
// books-api.test.ts). Maps a BookEntry row to the OpenAPI LedgerEntry shape,
// computing `reversed_by_entry_id` at read time (STR-022 only stores the
// backward link, `reverses_entry_id`) and applying the `from`/`to` date
// window a caller resolves (e.g. via financial-year.ts's FY boundaries).
import type { Database } from '@aws-blocks/blocks';
import { getBookEntries, type BookEntry, type BookName } from './books';
import type { PostingDirection } from './journal';

export type { BookName };

const BOOK_NAMES: readonly BookName[] = ['bank', 'cash', 'payment', 'expense'];

/** Type guard for the `book` path param — the four values the Admin OpenAPI declares. */
export function isBookName(value: string): value is BookName {
  return (BOOK_NAMES as readonly string[]).includes(value);
}

/** The Admin OpenAPI's LedgerEntry shape (components/schemas/LedgerEntry). */
export interface LedgerEntry {
  entry_id: string;
  book: BookName;
  entry_date: string;
  description: string;
  amount: string;
  direction: PostingDirection;
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
}

export interface ListBookEntriesOptions {
  /** Inclusive lower bound (YYYY-MM-DD) on entry_date. */
  from?: string;
  /** Inclusive upper bound (YYYY-MM-DD) on entry_date. */
  to?: string;
}

function inRange(entryDate: string, from?: string, to?: string): boolean {
  if (from !== undefined && entryDate < from) return false;
  if (to !== undefined && entryDate > to) return false;
  return true;
}

/** Builds a map of entry_id -> the id of the entry that reverses it, if any. */
function buildReversedByMap(entries: readonly BookEntry[]): Map<string, string> {
  const reversedBy = new Map<string, string>();
  for (const entry of entries) {
    if (entry.reverses_entry_id) {
      reversedBy.set(entry.reverses_entry_id, entry.entry_id);
    }
  }
  return reversedBy;
}

function toLedgerEntry(entry: BookEntry, book: BookName, reversedByEntryId: string | null): LedgerEntry {
  return {
    entry_id: entry.entry_id,
    book,
    entry_date: entry.posted_at.slice(0, 10),
    description: entry.description,
    amount: entry.amount,
    direction: entry.direction,
    reverses_entry_id: entry.reverses_entry_id,
    reversed_by_entry_id: reversedByEntryId,
  };
}

/** `GET /books/{book}/entries` — the whole book, optionally windowed to a `from`/`to` date range. */
export async function listBookEntries(
  db: Database,
  book: BookName,
  options: ListBookEntriesOptions = {},
): Promise<LedgerEntry[]> {
  const entries = await getBookEntries(db, book);
  const reversedBy = buildReversedByMap(entries);
  return entries
    .filter(entry => inRange(entry.posted_at.slice(0, 10), options.from, options.to))
    .map(entry => toLedgerEntry(entry, book, reversedBy.get(entry.entry_id) ?? null));
}

/** `GET /books/{book}/entries/{entryId}` — a single entry, or `null` if it doesn't exist in that book. */
export async function getBookEntry(db: Database, book: BookName, entryId: string): Promise<LedgerEntry | null> {
  const entries = await getBookEntries(db, book);
  const entry = entries.find(e => e.entry_id === entryId);
  if (!entry) return null;
  const reversal = entries.find(e => e.reverses_entry_id === entryId);
  return toLedgerEntry(entry, book, reversal?.entry_id ?? null);
}

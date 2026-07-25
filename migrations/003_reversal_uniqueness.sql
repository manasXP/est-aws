-- STR-022 (code review follow-up): closes a TOCTOU race in
-- reverseJournalEntry's "already reversed" guard. Purely additive (a new
-- index) — nothing is dropped or type-changed, so no
-- `-- contract-migration:` annotation is needed (see
-- aws-blocks/migrations-lint.ts).
--
-- The app-level check in aws-blocks/finance/reversal.ts (SELECT ... WHERE
-- reverses_entry_id = ...) runs outside a transaction, so two concurrent
-- reverseJournalEntry calls for the same entry can both pass it before
-- either commits its INSERT — reversing the same entry twice (violating
-- T-U3). A partial unique index makes "at most one reversal per entry" a
-- real DB-level constraint: the second racing INSERT now hits a
-- unique-constraint violation instead of succeeding. NULL is excluded via
-- the WHERE clause since ordinary (non-reversal) postings all have
-- reverses_entry_id = NULL and must not collide with each other.
CREATE UNIQUE INDEX journal_entries_reverses_entry_id_unique
  ON journal_entries (reverses_entry_id)
  WHERE reverses_entry_id IS NOT NULL;

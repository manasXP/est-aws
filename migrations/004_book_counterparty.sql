-- STR-023: books-as-views — counterparty classification tag on journal
-- lines. Purely additive (new nullable columns) — no destructive DDL, so no
-- `-- contract-migration:` annotation is needed (see
-- aws-blocks/migrations-lint.ts).
--
-- No member/vendor/employee registry exists yet in this codebase (E04/E09
-- haven't started), so this is deliberately just a classification tag, not
-- a foreign key into a real registry — an opaque identifier, forward-
-- compatible metadata for when that registry lands. `counterparty_type`
-- drives Payment Ledger ('member') vs Expense Ledger ('vendor'/'payee' —
-- 'payee' covers generic expense counterparties: employee salaries, other
-- expenses, per Finance & Compliance's Expense Ledger row) classification
-- in aws-blocks/finance/books.ts; Bank/Cash Book membership is a separate
-- axis keyed on ledger_accounts.kind, not this column.
ALTER TABLE journal_lines ADD COLUMN counterparty_type TEXT CHECK (counterparty_type IN ('member', 'vendor', 'payee'));
ALTER TABLE journal_lines ADD COLUMN counterparty_id TEXT;

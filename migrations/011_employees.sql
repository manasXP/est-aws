-- STR-042: employee records (Governance & Roles — employees are disjoint
-- from members by definition). Purely additive, no annotation needed.
CREATE TABLE employees (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  designation TEXT,
  email TEXT,
  phone TEXT,
  monthly_salary NUMERIC(14,2),
  joined_on DATE,
  -- Employee.capabilities (OpenAPI): JSON-serialized string array. Empty
  -- '[]' means not designated -- no admin account/login. Set only via
  -- setEmployeeCapabilities (PUT .../capabilities), never the generic
  -- create/update path -- same reasoning as members.member_status.
  capabilities TEXT NOT NULL DEFAULT '[]'
);

-- STR-042: a real ledger account for money actually leaving the society
-- (salary payments, future vendor payments) -- until now only 'bank'/'cash'
-- existed, which the prior STR-023 test fixtures paired against each other
-- as a bank<->cash transfer purely to exercise Expense Ledger read
-- projections (not meant as a real posting convention). kind='expense' is
-- a distinct value from 'bank'/'cash', so aws-blocks/finance/books.ts's
-- Bank/Cash Book filters (kind='bank'/'cash') don't pick it up.
INSERT INTO ledger_accounts (id, name, kind) VALUES ('expense', 'Expense', 'expense');

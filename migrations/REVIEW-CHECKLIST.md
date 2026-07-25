# Migration review checklist

`npm run lint:migrations` (CI pipeline gate 3, see
[[EST-Deploy/release-and-rollback|Release & Rollback]]) only catches
destructive DDL mechanically. It cannot judge the rules below — they require
knowing the fleet's rollout position and the migration's intent, which no
script can infer from SQL text alone. A human reviews every migration file
against this checklist before merge; a destructive migration additionally
needs a `-- contract-migration: <reason>` annotation (see
`aws-blocks/migrations-lint.ts`) to pass the automated gate at all.

## Expand-contract timing

From [[EST-Deploy/release-and-rollback|Release & Rollback]], "Database
migrations — expand-contract, always":

> Rollback of **code** must never require rollback of **data**:
>
> - **Expand** (release N): additive only — new tables/columns/indexes,
>   nullable or defaulted. Old code keeps working.
> - **Migrate** (N or N+1): backfill via `AsyncJob`, dual-write where needed.
> - **Contract** (N+1 or later): remove old paths only after the whole fleet
>   is past N.
>
> Never in any release: destructive DDL on populated tables in the same
> release that introduces the replacement.

Checklist:

- [ ] If this migration is a **contract** step, has the whole fleet (per
      `fleet.yaml`) already been upgraded past the release that introduced
      the replacement path?
- [ ] Does any table this migration touches destructively hold real
      (non-empty) data on any deployed society today?
- [ ] Is the replacement path (new table/column) already shipped and in use
      by the current code, so the old path is genuinely dead?

## Ledger append-only rule

From [[EST-Spec/okf-bundle/specifications/finance-and-compliance|Finance &
Compliance]]:

> Ledger entries are append-only with an audit trail; corrections are
> reversing entries, not edits.

And from [[EST-Deploy/release-and-rollback|Release & Rollback]]:

> Ledger data is additionally **append-only by domain rule** — corrections
> are reversing entries, never mutations
> ([[EST-Spec/okf-bundle/specifications/finance-and-compliance|Finance &
> Compliance]]) — so no migration may rewrite posted ledger rows.

Checklist:

- [ ] Does this migration `UPDATE` or `DELETE` any row in the journal or its
      derived-view tables once the ledger exists (E03+)? If so, stop — post a
      reversing entry instead; this is not a migration-time fix.

## Annotation format

```sql
-- contract-migration: <why this destructive step is safe now>
```

One line, at the top of the file, non-empty reason. The lint (`npm run
lint:migrations`) requires this to let a destructive migration pass CI; it
does not replace the checklist above — annotate only after working through
it.

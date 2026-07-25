import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitStatements } from '@aws-blocks/data-common';
import { SQL_FILE } from './migrations-runner';

export interface MigrationLintResult {
  file: string;
  /** Whether any statement in the file is destructive DDL. */
  destructive: boolean;
  /** Whether the file carries a `-- contract-migration: <reason>` annotation. */
  annotated: boolean;
  reason: string | null;
  /** False only for a destructive file with no annotation — that blocks the gate. */
  ok: boolean;
}

// Release & Rollback's expand-contract rule: destructive DDL on a populated
// table is never safe in the same release as its replacement. This lint only
// classifies the mechanically checkable core (Green section) — fleet
// position, populated-table timing, and the ledger append-only rule stay in
// the human review checklist (migrations/REVIEW-CHECKLIST.md), which this
// script cannot judge from SQL text alone.
//
// Known, accepted gap (not a full SQL parser): these require the exact
// `DROP TABLE` / `DROP COLUMN` / `... TYPE` spelling. Postgres also allows
// `DROP <col>` (COLUMN keyword omitted) and `SET DATA TYPE` as an alternate
// spelling for a type change — a migration using those forms would not be
// flagged. Widening the match risks false-positiving on `DROP CONSTRAINT` /
// `DROP DEFAULT` / `DROP NOT NULL`, which are not column drops; left as a
// human-review responsibility rather than chasing a real parser here.
const DESTRUCTIVE_PATTERNS = [
  /^\s*drop\s+table\b/i,
  // `[\s\S]*` (not `\s+`) between the table name and the clause: a single
  // ALTER TABLE can carry several comma-separated clauses before the
  // destructive one (e.g. `ADD COLUMN x, DROP COLUMN y`).
  /^\s*alter\s+table\s+\S+\b[\s\S]*\bdrop\s+column\b/i,
  // Any type change is flagged, not just lossy ones — judging compatibility
  // needs the existing column's data, which a text-only lint doesn't have.
  // Over-flagging into review is the safe default here.
  /^\s*alter\s+table\s+\S+\b[\s\S]*\balter\s+column\s+\S+\s+type\b/i,
];

const CONTRACT_ANNOTATION = /^--\s*contract-migration:\s*(\S.*)$/i;

function isDestructiveStatement(statement: string): boolean {
  return DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(statement));
}

/**
 * Find a `-- contract-migration: <reason>` annotation, but only among the
 * file's leading comment lines — matching the documented convention (one
 * line, at the top of the file). An annotation tacked on after the
 * destructive statement it's meant to excuse (or anywhere else past the
 * leading comment block) does not count.
 */
function extractLeadingAnnotation(sql: string): string | null {
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const match = trimmed.match(CONTRACT_ANNOTATION);
    if (match) return match[1].trim();
    if (!trimmed.startsWith('--')) return null;
  }
  return null;
}

export function lintMigrationSql(file: string, sql: string): MigrationLintResult {
  const destructive = splitStatements(sql).some(isDestructiveStatement);
  const reason = extractLeadingAnnotation(sql);
  const annotated = reason !== null;
  return { file, destructive, annotated, reason, ok: !destructive || annotated };
}

export function lintMigrationsDir(migrationsDir: string): MigrationLintResult[] {
  return readdirSync(migrationsDir)
    .filter(file => SQL_FILE.test(file))
    .map(file => lintMigrationSql(file, readFileSync(join(migrationsDir, file), 'utf-8')));
}

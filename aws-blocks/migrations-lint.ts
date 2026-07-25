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
const DESTRUCTIVE_PATTERNS = [
  /^\s*drop\s+table\b/i,
  /^\s*alter\s+table\s+\S+\s+drop\s+column\b/i,
  // Any type change is flagged, not just lossy ones — judging compatibility
  // needs the existing column's data, which a text-only lint doesn't have.
  // Over-flagging into review is the safe default here.
  /^\s*alter\s+table\s+\S+\s+alter\s+column\s+\S+\s+type\b/i,
];

const CONTRACT_ANNOTATION = /^--\s*contract-migration:\s*(\S.*)$/im;

function isDestructiveStatement(statement: string): boolean {
  return DESTRUCTIVE_PATTERNS.some(pattern => pattern.test(statement));
}

export function lintMigrationSql(file: string, sql: string): MigrationLintResult {
  const destructive = splitStatements(sql).some(isDestructiveStatement);
  const match = sql.match(CONTRACT_ANNOTATION);
  const reason = match ? match[1].trim() : null;
  const annotated = reason !== null;
  return { file, destructive, annotated, reason, ok: !destructive || annotated };
}

export function lintMigrationsDir(migrationsDir: string): MigrationLintResult[] {
  return readdirSync(migrationsDir)
    .filter(file => SQL_FILE.test(file))
    .map(file => lintMigrationSql(file, readFileSync(join(migrationsDir, file), 'utf-8')));
}

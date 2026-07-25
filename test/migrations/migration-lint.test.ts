import { describe, it, expect } from 'vitest';
import { lintMigrationSql } from '../../aws-blocks/migrations-lint';

// STR-012 — expand-contract migration discipline gate (T-U1..T-U3: no TC
// case covers this repo-tooling behavior, so all three are genuine-gap IDs
// per the story). The lint classifies a migration file's statements as
// additive or destructive; only unannotated destructive DDL blocks the gate.

describe('STR-012 migration lint — destructive DDL detection', () => {
  // T-U1
  it('fails a fixture migration containing destructive DDL with no contract annotation', () => {
    const dropTable = lintMigrationSql('001_drop_table.sql', 'DROP TABLE widgets;');
    expect(dropTable.destructive).toBe(true);
    expect(dropTable.ok).toBe(false);

    const dropColumn = lintMigrationSql('002_drop_column.sql', 'ALTER TABLE widgets DROP COLUMN legacy_name;');
    expect(dropColumn.destructive).toBe(true);
    expect(dropColumn.ok).toBe(false);

    const typeChange = lintMigrationSql('003_type_change.sql', 'ALTER TABLE widgets ALTER COLUMN price TYPE INTEGER;');
    expect(typeChange.destructive).toBe(true);
    expect(typeChange.ok).toBe(false);
  });

  // T-U2
  it('passes a purely additive fixture migration without ceremony', () => {
    const newTable = lintMigrationSql('001_new_table.sql', 'CREATE TABLE widgets (id TEXT PRIMARY KEY);');
    expect(newTable.destructive).toBe(false);
    expect(newTable.ok).toBe(true);

    const nullableColumn = lintMigrationSql('002_nullable_column.sql', 'ALTER TABLE widgets ADD COLUMN notes TEXT;');
    expect(nullableColumn.destructive).toBe(false);
    expect(nullableColumn.ok).toBe(true);

    const index = lintMigrationSql('003_index.sql', 'CREATE INDEX widgets_notes_idx ON widgets (notes);');
    expect(index.destructive).toBe(false);
    expect(index.ok).toBe(true);
  });

  // T-U3
  it('passes a destructive fixture carrying the explicit contract annotation, routed to review', () => {
    const result = lintMigrationSql(
      '004_drop_legacy.sql',
      '-- contract-migration: legacy_name replaced by name in 002, fleet past N per fleet.yaml\nALTER TABLE widgets DROP COLUMN legacy_name;',
    );
    expect(result.destructive).toBe(true);
    expect(result.annotated).toBe(true);
    expect(result.ok).toBe(true);
  });

  // Regression (code review): a multi-clause ALTER TABLE must still be
  // caught when the destructive clause isn't the first one.
  it('catches a destructive clause anywhere in a multi-clause ALTER TABLE', () => {
    const result = lintMigrationSql(
      '005_add_then_drop.sql',
      'ALTER TABLE widgets ADD COLUMN name TEXT, DROP COLUMN legacy_name;',
    );
    expect(result.destructive).toBe(true);
    expect(result.ok).toBe(false);
  });

  // Regression (code review): the annotation must be at the top of the
  // file, not tacked on after the destructive statement it's meant to
  // excuse — otherwise it stops meaning "reviewed before this shipped".
  it('does not accept a contract annotation placed after the destructive statement', () => {
    const result = lintMigrationSql(
      '006_late_annotation.sql',
      'DROP TABLE widgets;\n\n-- contract-migration: added after the fact, should not count',
    );
    expect(result.destructive).toBe(true);
    expect(result.annotated).toBe(false);
    expect(result.ok).toBe(false);
  });
});

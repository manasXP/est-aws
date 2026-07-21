import { describe, it, expect, beforeAll } from 'vitest';
import { sql } from '@aws-blocks/blocks';
import { db, documents } from '../aws-blocks/index';
import { SCOPE_ID, DB_BLOCK_ID, DOCUMENTS_BLOCK_ID } from '../aws-blocks/block-ids';

// STR-001: the local loop must be AWS-free. Strip any ambient AWS identity so a
// passing run proves the Blocks local implementations are in play.
beforeAll(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AWS_')) delete process.env[key];
  }
});

describe('STR-001 backend scaffold', () => {
  // T-U1
  it('executes against the Blocks local runtime with no AWS credentials', async () => {
    const rows = await db.query<{ two: number }>(sql`SELECT 1 + 1 AS two`);
    expect(rows).toEqual([{ two: 2 }]);
  });

  // T-U2 — stateful Block IDs are immutable once deployed; a rename here is
  // permanent data loss in production. These literals must never change.
  // Note: the specs write these as estatly/db and estatly/documents; Blocks
  // (v0.2.3) joins scope and block ID with a hyphen in the real fullId.
  it('fixes the stateful Block IDs estatly-db and estatly-documents forever', () => {
    expect(db.fullId).toBe('estatly-db');
    expect(documents.fullId).toBe('estatly-documents');
  });

  it('derives the Block IDs from the single constants module', () => {
    expect(`${SCOPE_ID}-${DB_BLOCK_ID}`).toBe(db.fullId);
    expect(`${SCOPE_ID}-${DOCUMENTS_BLOCK_ID}`).toBe(documents.fullId);
  });
});

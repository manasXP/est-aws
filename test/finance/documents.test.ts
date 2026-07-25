import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, FileBucket, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry } from '../../aws-blocks/finance/journal';
import { linkDocumentToEntry, getDocumentLinksForEntry, isDocumentLinkedToLedger, DocumentLinkError } from '../../aws-blocks/finance/documents';

// STR-025 — ledger-entry document links, unit cases. Follows the
// STR-021/022/023 test pattern: fresh Database + Scope per test, baseline +
// finance migrations applied via MIGRATIONS_DIR. A fresh FileBucket per test
// stands in for the (not-yet-built, E12) document registry — a document is
// addressed by its FileBucket object path.

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-025-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-025-test-${randomUUID()}`), 'documents');
  cleanupBuckets.push(bucket);
  return bucket;
}

async function postSamplePosting(db: Database): Promise<string> {
  const { entryId } = await postJournalEntry(db, 'sample posting', [
    { accountId: 'cash', direction: 'debit', amount: '100.00' },
    { accountId: 'bank', direction: 'credit', amount: '100.00' },
  ]);
  return entryId;
}

afterEach(async () => {
  while (cleanupDbs.length) {
    const db = cleanupDbs.pop()!;
    await (await db.getEngine()).destroy();
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  }
  while (cleanupBuckets.length) {
    const bucket = cleanupBuckets.pop()!;
    rmSync(`.bb-data/${bucket.fullId}`, { recursive: true, force: true });
  }
});

describe('STR-025 linkDocumentToEntry / getDocumentLinksForEntry', () => {
  // T-U1 (covers TC-FIN-060): linking multiple scanned documents to one
  // ledger entry persists all links, and each resolves to a presigned
  // download.
  it('persists multiple document links on one entry, each resolving to a presigned download', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const entryId = await postSamplePosting(db);
    await bucket.put('vouchers/v-1.pdf', 'voucher one', { contentType: 'application/pdf' });
    await bucket.put('vouchers/v-2.pdf', 'voucher two', { contentType: 'application/pdf' });

    await linkDocumentToEntry(db, bucket, entryId, 'vouchers/v-1.pdf');
    await linkDocumentToEntry(db, bucket, entryId, 'vouchers/v-2.pdf');

    const links = await getDocumentLinksForEntry(db, bucket, entryId);
    expect(links).toHaveLength(2);
    const byId = new Map(links.map(link => [link.documentId, link]));
    expect(byId.has('vouchers/v-1.pdf')).toBe(true);
    expect(byId.has('vouchers/v-2.pdf')).toBe(true);
    for (const link of links) {
      expect(link.downloadUrl).toMatch(/^https?:\/\//);
    }
  });

  it('rejects linking to a journal entry that does not exist', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await bucket.put('vouchers/v-1.pdf', 'voucher one');

    await expect(linkDocumentToEntry(db, bucket, 'no-such-entry', 'vouchers/v-1.pdf')).rejects.toThrow(DocumentLinkError);
  });

  it('rejects linking a document that does not exist in the bucket', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const entryId = await postSamplePosting(db);

    await expect(linkDocumentToEntry(db, bucket, entryId, 'vouchers/missing.pdf')).rejects.toThrow(DocumentLinkError);
  });

  it('rejects linking the same document twice to the same entry, writing no second link', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const entryId = await postSamplePosting(db);
    await bucket.put('vouchers/v-1.pdf', 'voucher one');
    await linkDocumentToEntry(db, bucket, entryId, 'vouchers/v-1.pdf');

    await expect(linkDocumentToEntry(db, bucket, entryId, 'vouchers/v-1.pdf')).rejects.toThrow(DocumentLinkError);

    const links = await getDocumentLinksForEntry(db, bucket, entryId);
    expect(links).toHaveLength(1);
  });
});

describe('STR-025 isDocumentLinkedToLedger — archive-blocking guard', () => {
  // T-U2 (covers TC-FIN-061): a document linked from a ledger entry is
  // reported as ledger-linked — the check E12's archive endpoint must
  // consult to return 409, since the archive endpoint itself is E12's, not
  // this story's.
  it('reports a linked document as ledger-linked', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const entryId = await postSamplePosting(db);
    await bucket.put('vouchers/v-1.pdf', 'voucher one');
    await linkDocumentToEntry(db, bucket, entryId, 'vouchers/v-1.pdf');

    await expect(isDocumentLinkedToLedger(db, 'vouchers/v-1.pdf')).resolves.toBe(true);
  });

  it('reports an unlinked document as not ledger-linked', async () => {
    const db = await freshMigratedDb();

    await expect(isDocumentLinkedToLedger(db, 'vouchers/never-linked.pdf')).resolves.toBe(false);
  });
});

describe('STR-025 journal_entry_documents — database-level append-only guard', () => {
  // T-U3: a document link, once attached, cannot be removed or repointed —
  // link rows are append-only like the journal itself, enforced at the
  // database level (same trigger pattern as journal_entries/journal_lines,
  // migrations/002).
  it('rejects a direct UPDATE of a document link, leaving it unchanged', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const entryId = await postSamplePosting(db);
    await bucket.put('vouchers/v-1.pdf', 'voucher one');
    await linkDocumentToEntry(db, bucket, entryId, 'vouchers/v-1.pdf');
    const link = await db.queryOne<{ id: string }>(
      sql`SELECT id FROM journal_entry_documents WHERE document_path = ${'vouchers/v-1.pdf'}`,
    );

    await expect(
      db.execute(sql`UPDATE journal_entry_documents SET document_path = 'vouchers/tampered.pdf' WHERE id = ${link!.id}`),
    ).rejects.toThrow();

    const unchanged = await db.queryOne<{ document_path: string }>(
      sql`SELECT document_path FROM journal_entry_documents WHERE id = ${link!.id}`,
    );
    expect(unchanged!.document_path).toBe('vouchers/v-1.pdf');
  });

  it('rejects a direct DELETE of a document link, leaving it in place', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const entryId = await postSamplePosting(db);
    await bucket.put('vouchers/v-1.pdf', 'voucher one');
    await linkDocumentToEntry(db, bucket, entryId, 'vouchers/v-1.pdf');
    const link = await db.queryOne<{ id: string }>(
      sql`SELECT id FROM journal_entry_documents WHERE document_path = ${'vouchers/v-1.pdf'}`,
    );

    await expect(db.execute(sql`DELETE FROM journal_entry_documents WHERE id = ${link!.id}`)).rejects.toThrow();

    const stillThere = await db.queryOne(sql`SELECT id FROM journal_entry_documents WHERE id = ${link!.id}`);
    expect(stillThere).not.toBeNull();
  });
});

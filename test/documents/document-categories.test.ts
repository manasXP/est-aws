import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, FileBucket, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import {
  registerDocument,
  updateDocument,
  listCategories,
  replaceCategories,
  DocumentCategoryConflictError,
  DocumentValidationError,
} from '../../aws-blocks/documents/documents-api';

// STR-113 — management-editable document category list, unit cases.
// Follows the STR-112 test pattern (test/documents/document-metadata.test.ts):
// fresh Database + Scope per test, baseline + domain migrations applied via
// MIGRATIONS_DIR, fresh FileBucket per test.

// The exact list migrations/032_documents.sql seeds (STR-111) — society,
// project, and member categories from the Document Management spec.
const SEEDED_CATEGORIES = [
  'Bye-laws',
  'Registration Certificate',
  'AGM/EC Meeting Minutes',
  'Audit Reports',
  'Insurance Policies',
  'Statutory Filings',
  'Circulars',
  'Sanctioned Plans',
  'Completion/Occupancy Certificates',
  'NOCs',
  'Vendor Contracts',
  'Share Certificate',
  'Sale/Transfer Deeds',
  'KYC',
  'Nomination Forms',
  'Correspondence',
];

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-113-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-113-test-${randomUUID()}`), 'documents');
  cleanupBuckets.push(bucket);
  return bucket;
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

async function registerSocietyDocument(db: Database, bucket: FileBucket, category: string): Promise<string> {
  const { documentId } = await registerDocument(db, bucket, {
    level: 'society',
    title: `Fixture in ${category}`,
    category,
    filename: 'fixture.pdf',
    contentType: 'application/pdf',
    uploadedBy: 'emp-1',
  });
  return documentId;
}

describe('STR-113 T-U1 (TC-DOC-004) — the category list is readable and seeded', () => {
  it('listCategories returns exactly the STR-111 migration-seeded categories', async () => {
    const db = await freshMigratedDb();

    const categories = await listCategories(db);

    expect([...categories].sort()).toEqual([...SEEDED_CATEGORIES].sort());
  });
});

describe('STR-113 T-U2 (TC-DOC-004) — a replaced list is immediately usable', () => {
  it('an added category is usable by document registration (STR-111) without redeploy', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    const replaced = await replaceCategories(db, [...SEEDED_CATEGORIES, 'Fire Safety Audits']);
    expect(replaced).toContain('Fire Safety Audits');
    expect(await listCategories(db)).toContain('Fire Safety Audits');

    const documentId = await registerSocietyDocument(db, bucket, 'Fire Safety Audits');
    const row = await db.queryOne<{ category: string }>(
      sql`SELECT category FROM documents WHERE id = ${documentId}`,
    );
    expect(row).toEqual({ category: 'Fire Safety Audits' });
  });

  it('an added category is usable by document metadata edit (STR-112) without redeploy', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const documentId = await registerSocietyDocument(db, bucket, 'Circulars');

    await replaceCategories(db, [...SEEDED_CATEGORIES, 'Fire Safety Audits']);

    const updated = await updateDocument(db, documentId, { category: 'Fire Safety Audits' }, { employeeId: 'emp-1' });
    expect(updated?.category).toBe('Fire Safety Audits');
  });
});

describe('STR-113 T-U3 — dropping an in-use category is rejected 409, no partial replace', () => {
  it('rejects a replace that removes a category referenced by an active document, leaving the stored list fully unchanged', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    await registerSocietyDocument(db, bucket, 'Circulars');

    // Drops in-use 'Circulars' AND adds a new category — the whole replace
    // must be rejected atomically: 'Circulars' kept, 'Should Not Land' never
    // stored (AC3: no partial replace).
    const incoming = SEEDED_CATEGORIES.filter(c => c !== 'Circulars').concat('Should Not Land');

    await expect(replaceCategories(db, incoming)).rejects.toBeInstanceOf(DocumentCategoryConflictError);

    const after = await listCategories(db);
    expect([...after].sort()).toEqual([...SEEDED_CATEGORIES].sort());
  });

  it('rejects a whitespace-only category name as 422 validation, leaving the list unchanged', async () => {
    const db = await freshMigratedDb();

    await expect(replaceCategories(db, [...SEEDED_CATEGORIES, '   '])).rejects.toBeInstanceOf(DocumentValidationError);

    const after = await listCategories(db);
    expect([...after].sort()).toEqual([...SEEDED_CATEGORIES].sort());
  });

  it('rejects a replace that removes a category referenced only by an archived document', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const documentId = await registerSocietyDocument(db, bucket, 'NOCs');
    await db.execute(sql`UPDATE documents SET status = 'archived' WHERE id = ${documentId}`);

    const incoming = SEEDED_CATEGORIES.filter(c => c !== 'NOCs');

    await expect(replaceCategories(db, incoming)).rejects.toBeInstanceOf(DocumentCategoryConflictError);

    const after = await listCategories(db);
    expect([...after].sort()).toEqual([...SEEDED_CATEGORIES].sort());
  });
});

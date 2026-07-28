import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, FileBucket, sql, matchRoute } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { postJournalEntry } from '../../aws-blocks/finance/journal';
import { linkDocumentToEntry } from '../../aws-blocks/finance/documents';
import { createMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import {
  registerDocument,
  getDocument,
  getDownloadUrl,
  listDocuments,
  archiveDocument,
  restoreDocument,
  isDocumentLinkedToInvoice,
  DocumentLifecycleConflictError,
} from '../../aws-blocks/documents/documents-api';

// STR-114 — archive/restore with the link-blocking guard, unit cases.
// Follows the STR-112/113 test pattern (test/documents/): fresh Database +
// Scope per test, baseline + domain migrations via MIGRATIONS_DIR, fresh
// FileBucket per test. The aws-blocks/index import exists only so T-U4 can
// interrogate the real route registry (the health.test.ts precedent).

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-114-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-114-test-${randomUUID()}`), 'documents');
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

/** Registers a society document and lands its file in the bucket so the
 * download path is live (getDownloadUrl requires the verified checksum). */
async function uploadedDocumentId(db: Database, bucket: FileBucket): Promise<{ documentId: string; fileKey: string }> {
  const { documentId } = await registerDocument(db, bucket, {
    level: 'society',
    title: 'Society Bye-laws',
    category: 'Bye-laws',
    filename: 'byelaws.pdf',
    contentType: 'application/pdf',
    uploadedBy: 'emp-1',
  });
  const row = await db.queryOne<{ file_key: string }>(sql`SELECT file_key FROM documents WHERE id = ${documentId}`);
  await bucket.put(row!.file_key, 'byelaws contents', { contentType: 'application/pdf' });
  return { documentId, fileKey: row!.file_key };
}

describe('STR-114 T-U1 (TC-DOC-020) — archive hides from the default listing, restore brings back', () => {
  it('an archived document leaves the default listing but stays fetchable and downloadable; restore returns it', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const { documentId } = await uploadedDocumentId(db, bucket);

    const listedBefore = await listDocuments(db, {});
    expect(listedBefore.map(d => d.documentId)).toContain(documentId);

    const archived = await archiveDocument(db, documentId);
    expect(archived?.status).toBe('archived');

    expect((await listDocuments(db, {})).map(d => d.documentId)).not.toContain(documentId);
    expect((await listDocuments(db, { status: 'archived' })).map(d => d.documentId)).toContain(documentId);

    const fetched = await getDocument(db, bucket, documentId);
    expect(fetched?.status).toBe('archived');
    expect(await getDownloadUrl(db, bucket, documentId)).not.toBeNull();

    const restored = await restoreDocument(db, documentId);
    expect(restored?.status).toBe('active');
    expect((await listDocuments(db, {})).map(d => d.documentId)).toContain(documentId);
  });
});

describe('STR-114 T-U2 (TC-DOC-021) — a ledger-linked document can never be archived', () => {
  it('archiving a document linked to a journal entry via STR-025 fails 409 and the document stays active', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const { documentId, fileKey } = await uploadedDocumentId(db, bucket);

    const { entryId } = await postJournalEntry(db, 'STR-114 fixture posting', [
      { accountId: 'cash', direction: 'debit', amount: '100.00' },
      { accountId: 'bank', direction: 'credit', amount: '100.00' },
    ]);
    await linkDocumentToEntry(db, bucket, entryId, fileKey);

    await expect(archiveDocument(db, documentId)).rejects.toBeInstanceOf(DocumentLifecycleConflictError);

    const row = await db.queryOne<{ status: string }>(sql`SELECT status FROM documents WHERE id = ${documentId}`);
    expect(row).toEqual({ status: 'active' });
  });

  it('the invoice half of the guard is a documented stub returning false pending E09', async () => {
    const db = await freshMigratedDb();

    expect(await isDocumentLinkedToInvoice(db, 'any-document-id')).toBe(false);
  });
});

describe('STR-114 T-U3 — invalid state transitions are 409, record unchanged', () => {
  it('archiving an already-archived document fails 409 and it stays archived', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const { documentId } = await uploadedDocumentId(db, bucket);
    await archiveDocument(db, documentId);

    await expect(archiveDocument(db, documentId)).rejects.toBeInstanceOf(DocumentLifecycleConflictError);

    const row = await db.queryOne<{ status: string }>(sql`SELECT status FROM documents WHERE id = ${documentId}`);
    expect(row).toEqual({ status: 'archived' });
  });

  it('restoring a document that is not archived fails 409 and it stays active', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const { documentId } = await uploadedDocumentId(db, bucket);

    await expect(restoreDocument(db, documentId)).rejects.toBeInstanceOf(DocumentLifecycleConflictError);

    const row = await db.queryOne<{ status: string }>(sql`SELECT status FROM documents WHERE id = ${documentId}`);
    expect(row).toEqual({ status: 'active' });
  });
});

describe('STR-114 — listDocuments level/entity filters and the all sentinel (review follow-up)', () => {
  it('level, projectId, and memberId each narrow the listing, and status=all returns archived rows too', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const project = await createProject(db, { name: 'Wing A' });
    const member = await createMember(db, { name: 'Asha Rao' });

    const society = await registerDocument(db, bucket, {
      level: 'society', title: 'Bye-laws', category: 'Bye-laws',
      filename: 's.pdf', contentType: 'application/pdf', uploadedBy: 'emp-1',
    });
    const proj = await registerDocument(db, bucket, {
      level: 'project', projectId: project.project_id, title: 'Sanction', category: 'Sanctioned Plans',
      filename: 'p.pdf', contentType: 'application/pdf', uploadedBy: 'emp-1',
    });
    const memb = await registerDocument(db, bucket, {
      level: 'member', memberId: member.member_id, title: 'KYC', category: 'KYC',
      filename: 'm.pdf', contentType: 'application/pdf', uploadedBy: 'emp-1',
    });

    expect((await listDocuments(db, { level: 'project' })).map(d => d.documentId)).toEqual([proj.documentId]);
    expect((await listDocuments(db, { projectId: project.project_id })).map(d => d.documentId)).toEqual([proj.documentId]);
    expect((await listDocuments(db, { memberId: member.member_id })).map(d => d.documentId)).toEqual([memb.documentId]);

    await archiveDocument(db, society.documentId);
    const all = (await listDocuments(db, { status: 'all' })).map(d => d.documentId);
    expect(all).toContain(society.documentId);
    expect(all).toContain(proj.documentId);
    expect(all).toContain(memb.documentId);
  });
});

describe('STR-114 T-U4 (TC-DOC-022) — no DELETE route exists for any document path', () => {
  it('the route registry resolves no DELETE for any /v1/documents* or /v1/document-categories path', () => {
    const paths = [
      '/v1/documents',
      '/v1/documents/some-id',
      '/v1/documents/some-id/download',
      '/v1/documents/some-id/archive',
      '/v1/documents/some-id/restore',
      '/v1/document-categories',
    ];
    for (const path of paths) {
      expect(matchRoute('DELETE', path), `expected no DELETE route for ${path}`).toBeFalsy();
    }
  });
});

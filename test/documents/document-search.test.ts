import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, FileBucket, sql, getRegisteredRoutes } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { registerDocument, updateDocument, listDocuments } from '../../aws-blocks/documents/documents-api';

// STR-115 — metadata full-text search, filters, and member_visible, unit
// cases. Follows the STR-112/113/114 test pattern (test/documents/): fresh
// Database + Scope per test, migrations via MIGRATIONS_DIR, fresh FileBucket
// per test. The aws-blocks/index import exists only so T-U4 can interrogate
// the real route registry (the STR-114 T-U4 / health.test.ts precedent).

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-115-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-115-test-${randomUUID()}`), 'documents');
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

type RegisterOverrides = Partial<Parameters<typeof registerDocument>[2]>;

async function registered(db: Database, bucket: FileBucket, overrides: RegisterOverrides = {}): Promise<string> {
  const { documentId } = await registerDocument(db, bucket, {
    level: 'society',
    title: 'Untitled fixture',
    category: 'Correspondence',
    filename: 'fixture.pdf',
    contentType: 'application/pdf',
    uploadedBy: 'emp-1',
    ...overrides,
  });
  return documentId;
}

function ids(docs: { documentId: string }[]): string[] {
  return docs.map(d => d.documentId);
}

describe('STR-115 T-U1 (TC-DOC-040) — q searches metadata fields, never file content', () => {
  it('matches a term appearing in title, category, tags, notes, or file_name', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    const byTitle = await registered(db, bucket, { title: 'Lift maintenance quotation' });
    const byCategory = await registered(db, bucket, { category: 'Sanctioned Plans' });
    const byTag = await registered(db, bucket, { tags: ['waterproofing'] });
    const byNotes = await registered(db, bucket, { notes: 'shared with the auditor in March' });
    const byFileName = await registered(db, bucket, { filename: 'gymnasium-invoice.pdf' });

    expect(ids(await listDocuments(db, { q: 'quotation' }))).toEqual([byTitle]);
    expect(ids(await listDocuments(db, { q: 'sanctioned' }))).toEqual([byCategory]);
    expect(ids(await listDocuments(db, { q: 'waterproofing' }))).toEqual([byTag]);
    expect(ids(await listDocuments(db, { q: 'auditor' }))).toEqual([byNotes]);
    expect(ids(await listDocuments(db, { q: 'gymnasium' }))).toEqual([byFileName]);
  });

  it('never matches a term that appears only inside the file bytes — content is not searched in v1', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    const documentId = await registered(db, bucket, { title: 'Plain title' });
    const row = await db.queryOne<{ file_key: string }>(sql`SELECT file_key FROM documents WHERE id = ${documentId}`);
    await bucket.put(row!.file_key, 'the xylophone budget is hidden in the bytes', { contentType: 'application/pdf' });

    expect(await listDocuments(db, { q: 'xylophone' })).toEqual([]);
  });
});

describe('STR-115 T-U2 — filters narrow the result set, alone and composed', () => {
  it('category and date-range filters narrow results, alone and together with q', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    const kyc = await registered(db, bucket, { title: 'Asha KYC papers', category: 'KYC' });
    const noc = await registered(db, bucket, { title: 'Asha NOC letter', category: 'NOCs' });

    expect(ids(await listDocuments(db, { category: 'KYC' }))).toEqual([kyc]);
    expect(ids(await listDocuments(db, { q: 'asha', category: 'NOCs' }))).toEqual([noc]);
    const askedBoth = ids(await listDocuments(db, { q: 'asha' }));
    expect(askedBoth).toContain(kyc);
    expect(askedBoth).toContain(noc);

    // Both fixtures were uploaded just now — a window around today contains
    // them, a window entirely in the past excludes them.
    const today = new Date().toISOString().slice(0, 10);
    expect(ids(await listDocuments(db, { uploadedFrom: today, uploadedTo: today })).sort())
      .toEqual([kyc, noc].sort());
    expect(await listDocuments(db, { uploadedFrom: '2000-01-01', uploadedTo: '2000-12-31' })).toEqual([]);
  });

  it('level and entity filters compose with q', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const project = await createProject(db, { name: 'Wing A' });
    const member = await createMember(db, { name: 'Asha Rao' });

    const projDoc = await registered(db, bucket, {
      level: 'project', projectId: project.project_id, title: 'Elevator sanction',
      category: 'Sanctioned Plans',
    });
    const membDoc = await registered(db, bucket, {
      level: 'member', memberId: member.member_id, title: 'Elevator complaint scan',
      category: 'Correspondence',
    });
    // Same level/entity as projDoc but no q-term — proves q contributes to
    // the composition instead of the level/entity filter doing all the work.
    await registered(db, bucket, {
      level: 'project', projectId: project.project_id, title: 'Garden landscaping plan',
      category: 'Sanctioned Plans',
    });

    expect(ids(await listDocuments(db, { q: 'elevator', level: 'project' }))).toEqual([projDoc]);
    expect(ids(await listDocuments(db, { q: 'elevator', memberId: member.member_id }))).toEqual([membDoc]);
    expect(ids(await listDocuments(db, { q: 'elevator', projectId: project.project_id }))).toEqual([projDoc]);
  });
});

describe('STR-115 T-U3 (TC-DOC-041) — member_visible defaults false, PATCH flips it, audited', () => {
  it('a freshly registered document is not member-visible unless the caller sets it on create', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    const defaulted = await registered(db, bucket, {});
    const explicit = await registered(db, bucket, { memberVisible: true });

    const rows = await db.query<{ id: string; member_visible: boolean }>(
      sql`SELECT id, member_visible FROM documents ORDER BY uploaded_at`,
    );
    expect(rows.find(r => r.id === defaulted)?.member_visible).toBe(false);
    expect(rows.find(r => r.id === explicit)?.member_visible).toBe(true);
  });

  it('updateDocument accepts member_visible and audits the flip like any other metadata edit', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const documentId = await registered(db, bucket, {});

    const updated = await updateDocument(db, documentId, { memberVisible: true }, { employeeId: 'emp-1' });
    expect(updated?.memberVisible).toBe(true);

    const audit = await db.queryOne<{ before_member_visible: boolean; after_member_visible: boolean }>(
      sql`SELECT before_member_visible, after_member_visible FROM document_metadata_audits WHERE document_id = ${documentId}`,
    );
    expect(audit).toEqual({ before_member_visible: false, after_member_visible: true });
  });
});

describe('STR-115 T-U4 (TC-DOC-042) — no member-at-large document endpoint exists', () => {
  it('no /v1/me/* route in the registry touches documents in any form', () => {
    const memberFacing = getRegisteredRoutes().filter(r => r.path.startsWith('/v1/me/'));
    const offenders = memberFacing.filter(r => /document/i.test(r.path));
    expect(offenders.map(r => `${r.method} ${r.path}`)).toEqual([]);
  });
});

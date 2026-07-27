import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, FileBucket, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { registerDocument, updateDocument, DocumentValidationError } from '../../aws-blocks/documents/documents-api';

// STR-112 — file immutability and audited metadata edits, unit cases.
// Follows the STR-111 test pattern (test/documents/documents-api.test.ts):
// fresh Database + Scope per test, baseline + domain migrations applied via
// MIGRATIONS_DIR, fresh FileBucket per test.

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-112-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-112-test-${randomUUID()}`), 'documents');
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

async function registeredDocumentId(db: Database, bucket: FileBucket): Promise<string> {
  const { documentId } = await registerDocument(db, bucket, {
    level: 'society',
    title: 'Society Bye-laws',
    category: 'Bye-laws',
    tags: ['statutory'],
    notes: 'original notes',
    filename: 'byelaws.pdf',
    contentType: 'application/pdf',
    uploadedBy: 'admin-1',
  });
  return documentId;
}

// The file-identity columns AC1 freezes -- selected before and after an edit
// and compared byte-for-byte.
function selectIdentityColumns(db: Database, documentId: string): Promise<Record<string, unknown> | null> {
  return db.queryOne<Record<string, unknown>>(
    sql`SELECT file_key, file_name, mime_type, checksum, size_bytes, level, project_id, member_id, uploaded_by, uploaded_at FROM documents WHERE id = ${documentId}`,
  );
}

describe('STR-112 T-U1 (TC-DOC-003) — metadata edits persist, file identity untouched', () => {
  it('edits title/category/tags/notes and leaves every file-identity field byte-for-byte unchanged', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const documentId = await registeredDocumentId(db, bucket);

    const before = await selectIdentityColumns(db, documentId);

    const updated = await updateDocument(db, documentId, {
      title: 'Society Bye-laws (2026 revision)',
      category: 'Circulars',
      tags: ['statutory', 'revised'],
      notes: 'corrected after AGM',
    }, { employeeId: 'emp-1' });

    expect(updated).toMatchObject({
      title: 'Society Bye-laws (2026 revision)',
      category: 'Circulars',
      tags: ['statutory', 'revised'],
      notes: 'corrected after AGM',
    });

    const row = await db.queryOne<{ title: string; category: string; tags: string[]; notes: string | null }>(
      sql`SELECT title, category, tags, notes FROM documents WHERE id = ${documentId}`,
    );
    expect(row).toEqual({
      title: 'Society Bye-laws (2026 revision)',
      category: 'Circulars',
      tags: ['statutory', 'revised'],
      notes: 'corrected after AGM',
    });

    const after = await selectIdentityColumns(db, documentId);
    expect(after).toStrictEqual(before);
  });
});

describe('STR-112 T-U2 (TC-DOC-002) — file-identity columns rejected at the database layer', () => {
  // STR-111's suite already exercises file_key and level; all six identity
  // columns are covered here as the story specifies (defense-in-depth beyond
  // DocumentPatch simply having no such field).
  it('rejects a direct UPDATE of file_key, leaving it unchanged', async () => {
    const db = await freshMigratedDb();
    const documentId = await registeredDocumentId(db, freshBucket());

    await expect(
      db.execute(sql`UPDATE documents SET file_key = 'tampered/key.pdf' WHERE id = ${documentId}`),
    ).rejects.toThrow();

    const after = await db.queryOne<{ file_key: string }>(sql`SELECT file_key FROM documents WHERE id = ${documentId}`);
    expect(after!.file_key).toBe(`documents/${documentId}/byelaws.pdf`);
  });

  it('rejects a direct UPDATE of file_name, leaving it unchanged', async () => {
    const db = await freshMigratedDb();
    const documentId = await registeredDocumentId(db, freshBucket());

    await expect(
      db.execute(sql`UPDATE documents SET file_name = 'tampered.pdf' WHERE id = ${documentId}`),
    ).rejects.toThrow();

    const after = await db.queryOne<{ file_name: string }>(sql`SELECT file_name FROM documents WHERE id = ${documentId}`);
    expect(after!.file_name).toBe('byelaws.pdf');
  });

  it('rejects a direct UPDATE of mime_type, leaving it unchanged', async () => {
    const db = await freshMigratedDb();
    const documentId = await registeredDocumentId(db, freshBucket());

    await expect(
      db.execute(sql`UPDATE documents SET mime_type = 'image/png' WHERE id = ${documentId}`),
    ).rejects.toThrow();

    const after = await db.queryOne<{ mime_type: string }>(sql`SELECT mime_type FROM documents WHERE id = ${documentId}`);
    expect(after!.mime_type).toBe('application/pdf');
  });

  it('rejects a direct UPDATE of level, leaving it unchanged', async () => {
    const db = await freshMigratedDb();
    const documentId = await registeredDocumentId(db, freshBucket());

    await expect(
      db.execute(sql`UPDATE documents SET level = 'project' WHERE id = ${documentId}`),
    ).rejects.toThrow();

    const after = await db.queryOne<{ level: string }>(sql`SELECT level FROM documents WHERE id = ${documentId}`);
    expect(after!.level).toBe('society');
  });

  it('rejects a direct UPDATE of project_id, leaving it unchanged', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const project = await createProject(db, { name: 'Wing A' });
    const { documentId } = await registerDocument(db, bucket, {
      level: 'project',
      projectId: project.project_id,
      title: 'Sanctioned Plan',
      category: 'Sanctioned Plans',
      filename: 'plan.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'admin-1',
    });

    await expect(
      db.execute(sql`UPDATE documents SET project_id = NULL WHERE id = ${documentId}`),
    ).rejects.toThrow();

    const after = await db.queryOne<{ project_id: string | null }>(sql`SELECT project_id FROM documents WHERE id = ${documentId}`);
    expect(after!.project_id).toBe(project.project_id);
  });

  it('rejects a direct UPDATE of member_id, leaving it unchanged', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const { documentId } = await registerDocument(db, bucket, {
      level: 'member',
      memberId: member.member_id,
      title: 'KYC scan',
      category: 'KYC',
      filename: 'kyc.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'admin-1',
    });

    await expect(
      db.execute(sql`UPDATE documents SET member_id = NULL WHERE id = ${documentId}`),
    ).rejects.toThrow();

    const after = await db.queryOne<{ member_id: string | null }>(sql`SELECT member_id FROM documents WHERE id = ${documentId}`);
    expect(after!.member_id).toBe(member.member_id);
  });
});

interface AuditRow {
  document_id: string;
  actor_member_id: string | null;
  actor_employee_id: string | null;
  before_title: string;
  after_title: string;
  before_category: string;
  after_category: string;
  before_tags: string;
  after_tags: string;
  before_notes: string | null;
  after_notes: string | null;
  created_at: string | Date;
}

describe('STR-112 T-U3 (AC3) — every successful edit inserts exactly one audit row', () => {
  it('records the employee actor, timestamp, and before/after title/category/tags/notes', async () => {
    const db = await freshMigratedDb();
    const documentId = await registeredDocumentId(db, freshBucket());

    await updateDocument(db, documentId, {
      title: 'Society Bye-laws (2026 revision)',
      category: 'Circulars',
      tags: ['statutory', 'revised'],
      notes: 'corrected after AGM',
    }, { employeeId: 'emp-9' });

    const rows = await db.query<AuditRow>(sql`SELECT * FROM document_metadata_audits WHERE document_id = ${documentId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_employee_id: 'emp-9',
      actor_member_id: null,
      before_title: 'Society Bye-laws',
      after_title: 'Society Bye-laws (2026 revision)',
      before_category: 'Bye-laws',
      after_category: 'Circulars',
      before_tags: JSON.stringify(['statutory']),
      after_tags: JSON.stringify(['statutory', 'revised']),
      before_notes: 'original notes',
      after_notes: 'corrected after AGM',
    });
    expect(rows[0].created_at).toBeTruthy();
  });

  it('records a member actor too, one row per edit', async () => {
    const db = await freshMigratedDb();
    const documentId = await registeredDocumentId(db, freshBucket());

    await updateDocument(db, documentId, { title: 'First correction' }, { employeeId: 'emp-9' });
    await updateDocument(db, documentId, { title: 'Second correction' }, { memberId: 'mem-3' });

    const rows = await db.query<AuditRow>(sql`SELECT * FROM document_metadata_audits WHERE document_id = ${documentId}`);
    expect(rows).toHaveLength(2);

    const memberEdit = rows.find(row => row.actor_member_id === 'mem-3');
    expect(memberEdit).toMatchObject({
      actor_member_id: 'mem-3',
      actor_employee_id: null,
      before_title: 'First correction',
      after_title: 'Second correction',
    });
  });
});

describe('STR-112 review fix — an empty title is rejected 422, matching registerDocument', () => {
  it('rejects title: "" with DocumentValidationError, leaving the document row and audit table unchanged', async () => {
    const db = await freshMigratedDb();
    const documentId = await registeredDocumentId(db, freshBucket());
    const before = await db.queryOne<Record<string, unknown>>(sql`SELECT * FROM documents WHERE id = ${documentId}`);

    await expect(
      updateDocument(db, documentId, { title: '' }, { employeeId: 'emp-1' }),
    ).rejects.toThrow(DocumentValidationError);

    const after = await db.queryOne<Record<string, unknown>>(sql`SELECT * FROM documents WHERE id = ${documentId}`);
    expect(after).toStrictEqual(before);

    const audits = await db.query(sql`SELECT id FROM document_metadata_audits WHERE document_id = ${documentId}`);
    expect(audits).toHaveLength(0);
  });
});

describe('STR-112 T-U4 (TC-DOC-003, AC4) — unknown category is rejected, nothing written', () => {
  it('rejects unknown_category and leaves the document row and audit table unchanged', async () => {
    const db = await freshMigratedDb();
    const documentId = await registeredDocumentId(db, freshBucket());
    const before = await db.queryOne<Record<string, unknown>>(sql`SELECT * FROM documents WHERE id = ${documentId}`);

    await expect(
      updateDocument(db, documentId, { title: 'Should not persist', category: 'Not A Real Category' }, { employeeId: 'emp-1' }),
    ).rejects.toMatchObject({ code: 'unknown_category' });

    const after = await db.queryOne<Record<string, unknown>>(sql`SELECT * FROM documents WHERE id = ${documentId}`);
    expect(after).toStrictEqual(before);

    const audits = await db.query(sql`SELECT id FROM document_metadata_audits WHERE document_id = ${documentId}`);
    expect(audits).toHaveLength(0);
  });
});

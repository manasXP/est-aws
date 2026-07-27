import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { Scope, Database, FileBucket, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import {
  registerDocument,
  getDocument,
  getDownloadUrl,
  DocumentValidationError,
} from '../../aws-blocks/documents/documents-api';

// STR-111 — document upload registration and presigned download, unit cases.
// Follows the STR-025/STR-082 test pattern: fresh Database + Scope per test,
// baseline + domain migrations applied via MIGRATIONS_DIR, fresh FileBucket
// per test.

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-111-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-111-test-${randomUUID()}`), 'documents');
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

describe('STR-111 T-U1 (TC-DOC-001) — registerDocument at each level', () => {
  it('registers a society-level document active immediately, with an upload URL', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    const result = await registerDocument(db, bucket, {
      level: 'society',
      title: 'Society Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'admin-1',
    });

    expect(result.documentId).toEqual(expect.any(String));
    expect(result.uploadUrl).toMatch(/^https?:\/\//);
    expect(result.expiresAt).toEqual(expect.any(String));

    const row = await db.queryOne<{ status: string }>(sql`SELECT status FROM documents WHERE id = ${result.documentId}`);
    expect(row!.status).toBe('active');
  });

  it('registers a project-level document against an existing project', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const project = await createProject(db, { name: 'Wing A' });

    const result = await registerDocument(db, bucket, {
      level: 'project',
      projectId: project.project_id,
      title: 'Sanctioned Plan',
      category: 'Sanctioned Plans',
      filename: 'plan.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'admin-1',
    });

    const row = await db.queryOne<{ status: string; project_id: string }>(
      sql`SELECT status, project_id FROM documents WHERE id = ${result.documentId}`,
    );
    expect(row!.status).toBe('active');
    expect(row!.project_id).toBe(project.project_id);
  });

  it('registers a member-level document against an existing member', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });

    const result = await registerDocument(db, bucket, {
      level: 'member',
      memberId: member.member_id,
      title: 'KYC scan',
      category: 'KYC',
      filename: 'kyc.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'admin-1',
    });

    const row = await db.queryOne<{ status: string; member_id: string }>(
      sql`SELECT status, member_id FROM documents WHERE id = ${result.documentId}`,
    );
    expect(row!.status).toBe('active');
    expect(row!.member_id).toBe(member.member_id);
  });
});

describe('STR-111 T-U2 — level/entity mismatch is rejected 422', () => {
  it('rejects level=society carrying a project_id', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const project = await createProject(db, { name: 'Wing A' });

    await expect(
      registerDocument(db, bucket, {
        level: 'society',
        projectId: project.project_id,
        title: 'Bad',
        category: 'Bye-laws',
        filename: 'f.pdf',
        contentType: 'application/pdf',
        uploadedBy: 'admin-1',
      }),
    ).rejects.toThrow(DocumentValidationError);
  });

  it('rejects level=society carrying a member_id', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });

    await expect(
      registerDocument(db, bucket, {
        level: 'society',
        memberId: member.member_id,
        title: 'Bad',
        category: 'Bye-laws',
        filename: 'f.pdf',
        contentType: 'application/pdf',
        uploadedBy: 'admin-1',
      }),
    ).rejects.toThrow(DocumentValidationError);
  });

  it('rejects level=project with no project_id', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    await expect(
      registerDocument(db, bucket, {
        level: 'project',
        title: 'Bad',
        category: 'Sanctioned Plans',
        filename: 'f.pdf',
        contentType: 'application/pdf',
        uploadedBy: 'admin-1',
      }),
    ).rejects.toThrow(DocumentValidationError);
  });

  it('rejects level=project with a project_id that does not exist', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    await expect(
      registerDocument(db, bucket, {
        level: 'project',
        projectId: 'no-such-project',
        title: 'Bad',
        category: 'Sanctioned Plans',
        filename: 'f.pdf',
        contentType: 'application/pdf',
        uploadedBy: 'admin-1',
      }),
    ).rejects.toThrow(DocumentValidationError);
  });

  it('rejects level=member with no member_id', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    await expect(
      registerDocument(db, bucket, {
        level: 'member',
        title: 'Bad',
        category: 'KYC',
        filename: 'f.pdf',
        contentType: 'application/pdf',
        uploadedBy: 'admin-1',
      }),
    ).rejects.toThrow(DocumentValidationError);
  });

  it('rejects level=member with a member_id that does not exist', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    await expect(
      registerDocument(db, bucket, {
        level: 'member',
        memberId: 'no-such-member',
        title: 'Bad',
        category: 'KYC',
        filename: 'f.pdf',
        contentType: 'application/pdf',
        uploadedBy: 'admin-1',
      }),
    ).rejects.toThrow(DocumentValidationError);
  });
});

describe('STR-111 review fix (Bug 2) — missing/invalid required fields are rejected 422, not an uncaught DB error', () => {
  it('rejects a missing level', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    await expect(
      registerDocument(db, bucket, {
        level: undefined as unknown as 'society',
        title: 'Bad',
        category: 'Bye-laws',
        filename: 'f.pdf',
        contentType: 'application/pdf',
        uploadedBy: 'admin-1',
      }),
    ).rejects.toThrow(DocumentValidationError);
  });

  it('rejects an invalid level value', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    await expect(
      registerDocument(db, bucket, {
        level: 'garbage' as unknown as 'society',
        title: 'Bad',
        category: 'Bye-laws',
        filename: 'f.pdf',
        contentType: 'application/pdf',
        uploadedBy: 'admin-1',
      }),
    ).rejects.toThrow(DocumentValidationError);
  });

  it('rejects a missing title', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    await expect(
      registerDocument(db, bucket, {
        level: 'society',
        title: undefined as unknown as string,
        category: 'Bye-laws',
        filename: 'f.pdf',
        contentType: 'application/pdf',
        uploadedBy: 'admin-1',
      }),
    ).rejects.toThrow(DocumentValidationError);
  });

  it('rejects a missing filename', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    await expect(
      registerDocument(db, bucket, {
        level: 'society',
        title: 'Bye-laws',
        category: 'Bye-laws',
        filename: undefined as unknown as string,
        contentType: 'application/pdf',
        uploadedBy: 'admin-1',
      }),
    ).rejects.toThrow(DocumentValidationError);
  });

  it('rejects a missing content_type', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    await expect(
      registerDocument(db, bucket, {
        level: 'society',
        title: 'Bye-laws',
        category: 'Bye-laws',
        filename: 'f.pdf',
        contentType: undefined as unknown as string,
        uploadedBy: 'admin-1',
      }),
    ).rejects.toThrow(DocumentValidationError);
  });
});

describe('STR-111 review fix (Bug 3) — level=project/member must not carry the other entity field', () => {
  it('rejects level=project carrying a member_id too', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const project = await createProject(db, { name: 'Wing A' });
    const member = await createMember(db, { name: 'Asha Rao' });

    await expect(
      registerDocument(db, bucket, {
        level: 'project',
        projectId: project.project_id,
        memberId: member.member_id,
        title: 'Bad',
        category: 'Sanctioned Plans',
        filename: 'f.pdf',
        contentType: 'application/pdf',
        uploadedBy: 'admin-1',
      }),
    ).rejects.toThrow(DocumentValidationError);
  });

  it('rejects level=member carrying a project_id too', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const project = await createProject(db, { name: 'Wing A' });
    const member = await createMember(db, { name: 'Asha Rao' });

    await expect(
      registerDocument(db, bucket, {
        level: 'member',
        memberId: member.member_id,
        projectId: project.project_id,
        title: 'Bad',
        category: 'KYC',
        filename: 'f.pdf',
        contentType: 'application/pdf',
        uploadedBy: 'admin-1',
      }),
    ).rejects.toThrow(DocumentValidationError);
  });
});

describe('STR-111 T-U3 — unknown category is rejected 422 unknown_category', () => {
  it('rejects a category not in document_categories', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    await expect(
      registerDocument(db, bucket, {
        level: 'society',
        title: 'Bad',
        category: 'Not A Real Category',
        filename: 'f.pdf',
        contentType: 'application/pdf',
        uploadedBy: 'admin-1',
      }),
    ).rejects.toMatchObject({ code: 'unknown_category' });
  });
});

describe('STR-111 T-U4 — lazy checksum/size verification from real uploaded bytes', () => {
  it('is NULL right after registration, then computed and persisted from the real file on the next getDocument', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    const { documentId } = await registerDocument(db, bucket, {
      level: 'society',
      title: 'Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'admin-1',
    });

    const beforeRow = await db.queryOne<{ checksum: string | null; size_bytes: number | null }>(
      sql`SELECT checksum, size_bytes FROM documents WHERE id = ${documentId}`,
    );
    expect(beforeRow!.checksum).toBeNull();
    expect(beforeRow!.size_bytes).toBeNull();

    const fileKeyRow = await db.queryOne<{ file_key: string }>(sql`SELECT file_key FROM documents WHERE id = ${documentId}`);
    const buffer = Buffer.from('the real uploaded bytes');
    await bucket.put(fileKeyRow!.file_key, buffer, { contentType: 'application/pdf' });

    const doc = await getDocument(db, bucket, documentId);
    const expectedChecksum = createHash('sha256').update(buffer).digest('hex');
    expect(doc!.checksum).toBe(expectedChecksum);
    expect(doc!.sizeBytes).toBe(buffer.length);

    const persistedRow = await db.queryOne<{ checksum: string | null; size_bytes: number | null }>(
      sql`SELECT checksum, size_bytes FROM documents WHERE id = ${documentId}`,
    );
    expect(persistedRow!.checksum).toBe(expectedChecksum);
    expect(persistedRow!.size_bytes).toBe(buffer.length);
  });
});

describe('STR-111 T-U5 (epic Risk gap) — an abandoned upload', () => {
  it('leaves checksum/size_bytes NULL and getDocument does not throw', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    const { documentId } = await registerDocument(db, bucket, {
      level: 'society',
      title: 'Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'admin-1',
    });

    const doc = await getDocument(db, bucket, documentId);
    expect(doc!.checksum).toBeNull();
    expect(doc!.sizeBytes).toBeNull();
  });

  it('getDownloadUrl returns null (route 404s) for a file that never landed', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    const { documentId } = await registerDocument(db, bucket, {
      level: 'society',
      title: 'Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'admin-1',
    });

    await expect(getDownloadUrl(db, bucket, documentId)).resolves.toBeNull();
  });
});

describe('STR-111 review fix (Bug 4) — documents_identity_immutable trigger, database-level guard', () => {
  // Mirrors the migrations/002_journal_immutability.sql assertion style
  // (test/finance/reversal.test.ts) -- the trigger's success side is proven
  // incidentally by T-U4's lazy checksum test, but nothing in the diff
  // exercises its rejection side directly.
  it('rejects a direct UPDATE of file_key, leaving it unchanged', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    const { documentId } = await registerDocument(db, bucket, {
      level: 'society',
      title: 'Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'admin-1',
    });
    const before = await db.queryOne<{ file_key: string }>(sql`SELECT file_key FROM documents WHERE id = ${documentId}`);

    await expect(
      db.execute(sql`UPDATE documents SET file_key = 'tampered/key.pdf' WHERE id = ${documentId}`),
    ).rejects.toThrow();

    const after = await db.queryOne<{ file_key: string }>(sql`SELECT file_key FROM documents WHERE id = ${documentId}`);
    expect(after!.file_key).toBe(before!.file_key);
  });

  it('rejects a direct UPDATE of level, leaving it unchanged', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();

    const { documentId } = await registerDocument(db, bucket, {
      level: 'society',
      title: 'Bye-laws',
      category: 'Bye-laws',
      filename: 'byelaws.pdf',
      contentType: 'application/pdf',
      uploadedBy: 'admin-1',
    });

    await expect(
      db.execute(sql`UPDATE documents SET level = 'project' WHERE id = ${documentId}`),
    ).rejects.toThrow();

    const after = await db.queryOne<{ level: string }>(sql`SELECT level FROM documents WHERE id = ${documentId}`);
    expect(after!.level).toBe('society');
  });
});

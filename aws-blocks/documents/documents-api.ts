// STR-111: the document registry foundation (Document Management spec) --
// registration with a presigned upload URL, and lazy checksum/size
// verification from the real uploaded bytes (no client-declared checksum,
// no confirm endpoint -- see the story's "checksum verification, and the
// confirm-endpoint gap" section). Reuses the shared `documents` FileBucket
// (STR-025, DOCUMENTS_BLOCK_ID) -- no second bucket.
import { randomUUID, createHash } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, FileBucket, Transaction } from '@aws-blocks/blocks';
import { ValidationError, ConflictError } from '../http/problem-response';
import { isDocumentLinkedToLedger } from '../finance/documents';
import { getMember } from '../members/members-api';
import { getProject } from '../projects/projects-api';
import { pgTextArray } from '../sql-array';
import type { Actor } from '../members/capabilities';

export type DocumentLevel = 'society' | 'project' | 'member';
export type DocumentStatus = 'active' | 'archived';

/** Domain rejection for a registration attempt carrying an invalid
 * level/entity combination or an unknown category. Nothing is written when
 * this is thrown. `code` is only set for the one case the contract names a
 * specific Error code for (`unknown_category`, T-U3); every other rejection
 * maps to the generic 422 validation_error via sendValidationError. */
export class DocumentValidationError extends ValidationError {
  constructor(message: string, public readonly code?: 'unknown_category') {
    super(message);
    this.name = 'DocumentValidationError';
  }
}

export interface DocumentRecord {
  documentId: string;
  level: DocumentLevel;
  projectId: string | null;
  memberId: string | null;
  title: string;
  category: string;
  tags: string[];
  notes: string | null;
  fileKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number | null;
  checksum: string | null;
  status: DocumentStatus;
  memberVisible: boolean;
  uploadedBy: string;
  uploadedAt: string;
}

interface DocumentRow {
  id: string;
  level: DocumentLevel;
  project_id: string | null;
  member_id: string | null;
  title: string;
  category: string;
  tags: string[];
  notes: string | null;
  file_key: string;
  file_name: string;
  mime_type: string;
  size_bytes: number | null;
  checksum: string | null;
  status: DocumentStatus;
  member_visible: boolean;
  uploaded_by: string;
  uploaded_at: string | Date;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    documentId: row.id,
    level: row.level,
    projectId: row.project_id,
    memberId: row.member_id,
    title: row.title,
    category: row.category,
    tags: row.tags,
    notes: row.notes,
    fileKey: row.file_key,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    checksum: row.checksum,
    status: row.status,
    memberVisible: row.member_visible,
    uploadedBy: row.uploaded_by,
    uploadedAt: toIso(row.uploaded_at),
  };
}

/** STR-113: domain rejection for a category-list replace that would drop a
 * category still referenced by any document, active or archived (AC3).
 * Nothing is written when this is thrown. */
export class DocumentCategoryConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentCategoryConflictError';
  }
}

/** `GET /v1/document-categories` (STR-113, AC1): the society's current
 * category list, seeded by migrations/032_documents.sql. */
export async function listCategories(db: Database): Promise<string[]> {
  const rows = await db.query<{ name: string }>(sql`SELECT name FROM document_categories ORDER BY name`);
  return rows.map(row => row.name);
}

/**
 * `PUT /v1/document-categories` business logic (STR-113, AC2/AC3): replaces
 * the whole set — the STR-057/STR-043 replace-semantics precedent. Runs in
 * one transaction: rejects 409 (writing nothing) if any removed category is
 * still referenced by a document, active or archived; otherwise deletes the
 * removed names and inserts the added ones. Kept rows are left in place
 * rather than delete-and-reinsert-everything because documents.category's
 * FK REFERENCES document_categories(name) — deleting a kept, in-use row
 * would violate it even transiently inside the transaction.
 */
export async function replaceCategories(db: Database, categories: unknown): Promise<string[]> {
  if (!Array.isArray(categories) || !categories.every(c => typeof c === 'string' && c.trim().length > 0)) {
    throw new DocumentValidationError('categories must be an array of non-empty strings.');
  }
  const incoming = [...new Set(categories as string[])];

  await db.transaction(async tx => {
    const current = (await tx.query<{ name: string }>(sql`SELECT name FROM document_categories`)).map(r => r.name);
    const removed = current.filter(name => !incoming.includes(name));
    const added = incoming.filter(name => !current.includes(name));

    if (removed.length > 0) {
      const inUse = await tx.query<{ category: string }>(
        sql`SELECT DISTINCT category FROM documents WHERE category = ANY(${pgTextArray(removed)}::text[])`,
      );
      if (inUse.length > 0) {
        throw new DocumentCategoryConflictError(
          `Cannot remove categories still in use by documents: ${inUse.map(r => r.category).join(', ')}.`,
        );
      }
      await tx.execute(sql`DELETE FROM document_categories WHERE name = ANY(${pgTextArray(removed)}::text[])`);
    }
    for (const name of added) {
      await tx.execute(sql`INSERT INTO document_categories (name) VALUES (${name})`);
    }
  });

  // Re-read rather than echoing `incoming` so PUT's response body carries
  // the same ordering GET does (review finding: request-order vs ORDER BY
  // name would otherwise disagree between the two).
  return listCategories(db);
}

/** Whether `category` is in the (management-editable, STR-112/113) seeded
 * document_categories list. Exported for STR-112/113's reuse. */
export async function isValidCategory(db: Database | Transaction, category: string): Promise<boolean> {
  const row = await db.queryOne(sql`SELECT name FROM document_categories WHERE name = ${category}`);
  return row !== null;
}

export interface RegisterDocumentInput {
  level: DocumentLevel;
  projectId?: string | null;
  memberId?: string | null;
  title: string;
  category: string;
  tags?: string[];
  notes?: string | null;
  memberVisible?: boolean;
  filename: string;
  contentType: string;
  uploadedBy: string;
}

export interface RegisterDocumentResult {
  documentId: string;
  uploadUrl: string;
  expiresAt: string;
}

// The presigned upload/download URLs' lifetime -- no contract-specified
// value, so a sane short-lived window (mirrors STR-079's receipt-download
// precedent of picking one where the spec is silent). Exported so the route
// layer can compute `expires_at` for the download endpoint the same way it's
// computed here for `upload_url`.
export const UPLOAD_URL_EXPIRES_IN_SECONDS = 600;
export const DOWNLOAD_URL_EXPIRES_IN_SECONDS = 600;

/**
 * `POST /v1/documents` business logic (AC1, AC2, TC-DOC-001): validates the
 * level/entity combination and the category, then inserts the row `active`
 * immediately (no confirm step) and returns a presigned upload URL. Nothing
 * is written if validation fails.
 */
export async function registerDocument(
  db: Database,
  bucket: FileBucket,
  input: RegisterDocumentInput,
): Promise<RegisterDocumentResult> {
  if (input.level !== 'society' && input.level !== 'project' && input.level !== 'member') {
    throw new DocumentValidationError('level must be one of society, project, member.');
  }
  if (!input.title) {
    throw new DocumentValidationError('title is required.');
  }
  if (!input.filename) {
    throw new DocumentValidationError('filename is required.');
  }
  if (!input.contentType) {
    throw new DocumentValidationError('content_type is required.');
  }

  if (input.level === 'society') {
    if (input.projectId != null || input.memberId != null) {
      throw new DocumentValidationError('level=society must not carry a project_id or member_id.');
    }
  } else if (input.level === 'project') {
    if (!input.projectId) {
      throw new DocumentValidationError('project_id is required when level=project.');
    }
    if (input.memberId != null) {
      throw new DocumentValidationError('level=project must not carry a member_id.');
    }
    const project = await getProject(db, input.projectId);
    if (!project) {
      throw new DocumentValidationError(`No project ${input.projectId}.`);
    }
  } else if (input.level === 'member') {
    if (!input.memberId) {
      throw new DocumentValidationError('member_id is required when level=member.');
    }
    if (input.projectId != null) {
      throw new DocumentValidationError('level=member must not carry a project_id.');
    }
    const member = await getMember(db, input.memberId);
    if (!member) {
      throw new DocumentValidationError(`No member ${input.memberId}.`);
    }
  }

  if (!(await isValidCategory(db, input.category))) {
    throw new DocumentValidationError(`Unknown category: ${input.category}`, 'unknown_category');
  }

  const documentId = randomUUID();
  const fileKey = `documents/${documentId}/${input.filename}`;

  await db.execute(
    sql`INSERT INTO documents (id, level, project_id, member_id, title, category, tags, notes, file_key, file_name, mime_type, member_visible, uploaded_by, status)
        VALUES (${documentId}, ${input.level}, ${input.projectId ?? null}, ${input.memberId ?? null}, ${input.title}, ${input.category}, ${pgTextArray(input.tags ?? [])}::text[], ${input.notes ?? null}, ${fileKey}, ${input.filename}, ${input.contentType}, ${input.memberVisible ?? false}, ${input.uploadedBy}, 'active')`,
  );

  const uploadUrl = await bucket.putUrl(fileKey, { contentType: input.contentType, expiresIn: UPLOAD_URL_EXPIRES_IN_SECONDS });
  const expiresAt = new Date(Date.now() + UPLOAD_URL_EXPIRES_IN_SECONDS * 1000).toISOString();

  return { documentId, uploadUrl, expiresAt };
}

/** Bare row read with NONE of getDocument's lazy checksum side effects
 * (bucket read, sha256, UPDATE) — for gates that must not do storage work
 * on behalf of callers who may turn out unauthorized (STR-116 review:
 * the PC download route evaluates its 403 on this, then lets only
 * authorized callers reach the lazily-verifying download path). */
export async function getDocumentMetadata(db: Database, documentId: string): Promise<DocumentRecord | null> {
  const row = await db.queryOne<DocumentRow>(sql`SELECT * FROM documents WHERE id = ${documentId}`);
  return row ? toDocument(row) : null;
}

/**
 * `GET /v1/documents/{documentId}` (AC2, epic Risk mitigation): reads the
 * row, lazily computing and persisting `checksum`/`size_bytes` from the real
 * uploaded bytes the first time the file is actually read (never trusted
 * from the client). If the file hasn't landed yet (abandoned upload, T-U5),
 * both stay `null` -- no error, no retry loop, just re-checked on every
 * subsequent read until the file exists. Returns `null` if `documentId`
 * doesn't exist at all.
 */
export async function getDocument(db: Database, bucket: FileBucket, documentId: string): Promise<DocumentRecord | null> {
  const row = await db.queryOne<DocumentRow>(sql`SELECT * FROM documents WHERE id = ${documentId}`);
  if (!row) return null;

  if (row.checksum === null && row.size_bytes === null) {
    const file = await bucket.get(row.file_key);
    if (file) {
      const checksum = createHash('sha256').update(file.body).digest('hex');
      const sizeBytes = file.body.length;
      await db.execute(
        sql`UPDATE documents SET checksum = ${checksum}, size_bytes = ${sizeBytes} WHERE id = ${documentId}`,
      );
      row.checksum = checksum;
      row.size_bytes = sizeBytes;
    }
  }

  return toDocument(row);
}

// STR-112: exactly the four fields the story's user story allows;
// `member_visible` joined the set in STR-115 (TC-DOC-041) — one more
// audited column, no second PATCH handler.
export interface DocumentMetadataPatch {
  title?: string;
  category?: string;
  tags?: string[];
  notes?: string | null;
  memberVisible?: boolean;
}

/**
 * `PATCH /v1/documents/{documentId}` business logic (STR-112, AC1/AC3/AC4):
 * edits metadata only -- the file-identity columns are never touched (and
 * the documents_identity_immutable trigger guards them at the database
 * layer regardless, AC2). Validates `category` via the same isValidCategory
 * check as registration; nothing is written on rejection. Every successful
 * edit inserts one document_metadata_audits row (actor, timestamp,
 * before/after values, `tags` JSON-serialized as TEXT) in the same
 * transaction as the UPDATE. Returns `null` if `documentId` doesn't exist
 * (the route 404s).
 */
export async function updateDocument(
  db: Database,
  documentId: string,
  patch: DocumentMetadataPatch,
  actor: Actor,
): Promise<DocumentRecord | null> {
  return db.transaction(async tx => {
    // FOR UPDATE so two concurrent PATCHes serialize on the row and can't
    // both audit the same before-values (the STR-081 precedent,
    // work-orders.ts's amendWorkOrder). Like there, the single-connection
    // PGlite local mock can't exercise true concurrent blocking, so this is
    // a production (real Postgres/Aurora) correctness fix, not a
    // locally-provable one.
    const row = await tx.queryOne<DocumentRow>(sql`SELECT * FROM documents WHERE id = ${documentId} FOR UPDATE`);
    if (!row) return null;

    // Parity with registerDocument's `if (!input.title)` rejection -- an
    // edit can't blank out the title registration would never have
    // accepted. `!patch.title` also catches a `null` smuggled past the
    // route's `!== undefined` pass-through.
    if (patch.title !== undefined && !patch.title) {
      throw new DocumentValidationError('title must not be empty.');
    }
    if (patch.category !== undefined && !(await isValidCategory(tx, patch.category))) {
      throw new DocumentValidationError(`Unknown category: ${patch.category}`, 'unknown_category');
    }

    const title = patch.title ?? row.title;
    const category = patch.category ?? row.category;
    const tags = patch.tags ?? row.tags;
    const notes = patch.notes !== undefined ? patch.notes : row.notes;
    const memberVisible = patch.memberVisible ?? row.member_visible;

    await tx.execute(
      sql`UPDATE documents SET title = ${title}, category = ${category}, tags = ${pgTextArray(tags)}::text[], notes = ${notes}, member_visible = ${memberVisible} WHERE id = ${documentId}`,
    );
    await tx.execute(
      sql`INSERT INTO document_metadata_audits (id, document_id, actor_member_id, actor_employee_id, before_title, after_title, before_category, after_category, before_tags, after_tags, before_notes, after_notes, before_member_visible, after_member_visible)
          VALUES (${randomUUID()}, ${documentId}, ${'memberId' in actor ? actor.memberId : null}, ${'employeeId' in actor ? actor.employeeId : null}, ${row.title}, ${title}, ${row.category}, ${category}, ${JSON.stringify(row.tags)}, ${JSON.stringify(tags)}, ${row.notes}, ${notes}, ${row.member_visible}, ${memberVisible})`,
    );

    return toDocument({ ...row, title, category, tags, notes, member_visible: memberVisible });
  });
}

/** STR-114: domain rejection for an archive/restore invalid in the
 * document's current state, or an archive blocked because the document is
 * compliance evidence (ledger- or invoice-linked). Nothing is written when
 * this is thrown. Named after members-api.ts's MemberLifecycleConflictError
 * precedent. */
export class DocumentLifecycleConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentLifecycleConflictError';
  }
}

export interface ListDocumentsFilters {
  status?: DocumentStatus | 'all';
  level?: DocumentLevel;
  projectId?: string;
  memberId?: string;
  q?: string;
  category?: string;
  uploadedFrom?: string;
  uploadedTo?: string;
}

/**
 * The document listing behind `GET /v1/documents` (STR-114 base, STR-115
 * search): `status` defaults to `active`, so archived documents are
 * excluded unless asked for (`archived` or `all`). `q` is Postgres FTS
 * (plainto_tsquery) against migrations/038's generated `search_vector` —
 * metadata only, never file content (TC-DOC-040). `uploaded_to` is a
 * date-only bound made inclusive of its whole day.
 */
export async function listDocuments(db: Database, filters: ListDocumentsFilters): Promise<DocumentRecord[]> {
  const status = filters.status ?? 'active';
  const rows = await db.query<DocumentRow>(sql`
    SELECT * FROM documents
    WHERE (${status} = 'all' OR status = ${status})
      AND (${filters.level ?? null}::text IS NULL OR level = ${filters.level ?? null})
      AND (${filters.projectId ?? null}::text IS NULL OR project_id = ${filters.projectId ?? null})
      AND (${filters.memberId ?? null}::text IS NULL OR member_id = ${filters.memberId ?? null})
      AND (${filters.q ?? null}::text IS NULL OR search_vector @@ plainto_tsquery('english', ${filters.q ?? null}))
      AND (${filters.category ?? null}::text IS NULL OR category = ${filters.category ?? null})
      AND (${filters.uploadedFrom ?? null}::date IS NULL OR uploaded_at >= ${filters.uploadedFrom ?? null}::date)
      AND (${filters.uploadedTo ?? null}::date IS NULL OR uploaded_at < ${filters.uploadedTo ?? null}::date + 1)
    ORDER BY uploaded_at DESC, id`);
  return rows.map(toDocument);
}

/**
 * The invoice half of the archive-blocking guard (TC-DOC-021) — a stub
 * returning `false` unconditionally: the `vendor_invoices` table it must
 * consult belongs to E09 (Vendor workflow), which has no story files cut
 * yet, so there is nothing to look up today. Flagged in STR-114 for
 * whoever cuts E09's stories: replace this with a real
 * `vendor_invoices.document_id` lookup and re-verify TC-DOC-021's invoice
 * clause at that point. (The STR-043 "lookup port, stubbed until the
 * upstream epic ships" pattern.)
 */
export async function isDocumentLinkedToInvoice(_db: Database, _documentId: string): Promise<boolean> {
  return false;
}

/**
 * `POST /v1/documents/{documentId}/archive` business logic (STR-114,
 * AC1/AC2/AC3): transactionally re-checks status under a row lock, then
 * consults STR-025's `isDocumentLinkedToLedger` (called unchanged, against
 * the row's internal `file_key` — the same FileBucket path STR-025 links
 * by) plus the E09-stubbed invoice guard, and only then flips the status.
 * The guards take the outer `db` handle because STR-025's signature is
 * `Database` (a `Transaction` is not one structurally) — they read tables
 * this transaction never writes, so the read is safe either way. Returns
 * `null` if `documentId` doesn't exist (the route 404s).
 */
export async function archiveDocument(db: Database, documentId: string): Promise<DocumentRecord | null> {
  return db.transaction(async tx => {
    const row = await tx.queryOne<DocumentRow>(sql`SELECT * FROM documents WHERE id = ${documentId} FOR UPDATE`);
    if (!row) return null;

    if (row.status === 'archived') {
      throw new DocumentLifecycleConflictError(`Document ${documentId} is already archived.`);
    }
    if (await isDocumentLinkedToLedger(db, row.file_key)) {
      throw new DocumentLifecycleConflictError(
        `Document ${documentId} is linked to a ledger entry — compliance evidence is never archived.`,
      );
    }
    if (await isDocumentLinkedToInvoice(db, documentId)) {
      throw new DocumentLifecycleConflictError(
        `Document ${documentId} is linked to a vendor invoice — compliance evidence is never archived.`,
      );
    }

    await tx.execute(sql`UPDATE documents SET status = 'archived' WHERE id = ${documentId}`);
    return toDocument({ ...row, status: 'archived' });
  });
}

/**
 * `POST /v1/documents/{documentId}/restore` business logic (STR-114, AC1/
 * AC3): the inverse flip, 409 unless currently archived. Returns `null` if
 * `documentId` doesn't exist (the route 404s).
 */
export async function restoreDocument(db: Database, documentId: string): Promise<DocumentRecord | null> {
  return db.transaction(async tx => {
    const row = await tx.queryOne<DocumentRow>(sql`SELECT * FROM documents WHERE id = ${documentId} FOR UPDATE`);
    if (!row) return null;

    if (row.status !== 'archived') {
      throw new DocumentLifecycleConflictError(`Document ${documentId} is not archived.`);
    }

    await tx.execute(sql`UPDATE documents SET status = 'active' WHERE id = ${documentId}`);
    return toDocument({ ...row, status: 'active' });
  });
}

/**
 * `GET /v1/documents/{documentId}/download` (AC3, T-U5): `null` if the
 * document doesn't exist OR its file never actually landed in the bucket --
 * either way the route 404s cleanly, never throwing. Shares getDocument's
 * existence check (`checksum` is non-null iff the file has ever been seen
 * to exist) rather than a third, separate `bucket.get` round trip.
 */
export async function getDownloadUrl(db: Database, bucket: FileBucket, documentId: string): Promise<string | null> {
  const doc = await getDocument(db, bucket, documentId);
  if (!doc || doc.checksum === null) return null;

  return bucket.getUrl(doc.fileKey, { expiresIn: DOWNLOAD_URL_EXPIRES_IN_SECONDS });
}

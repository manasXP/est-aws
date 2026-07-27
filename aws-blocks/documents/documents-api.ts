// STR-111: the document registry foundation (Document Management spec) --
// registration with a presigned upload URL, and lazy checksum/size
// verification from the real uploaded bytes (no client-declared checksum,
// no confirm endpoint -- see the story's "checksum verification, and the
// confirm-endpoint gap" section). Reuses the shared `documents` FileBucket
// (STR-025, DOCUMENTS_BLOCK_ID) -- no second bucket.
import { randomUUID, createHash } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, FileBucket, Transaction } from '@aws-blocks/blocks';
import { ValidationError } from '../http/problem-response';
import { getMember } from '../members/members-api';
import { getProject } from '../projects/projects-api';
import { pgTextArray } from '../sql-array';

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
  if (input.level === 'society') {
    if (input.projectId != null || input.memberId != null) {
      throw new DocumentValidationError('level=society must not carry a project_id or member_id.');
    }
  } else if (input.level === 'project') {
    if (!input.projectId) {
      throw new DocumentValidationError('project_id is required when level=project.');
    }
    const project = await getProject(db, input.projectId);
    if (!project) {
      throw new DocumentValidationError(`No project ${input.projectId}.`);
    }
  } else if (input.level === 'member') {
    if (!input.memberId) {
      throw new DocumentValidationError('member_id is required when level=member.');
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

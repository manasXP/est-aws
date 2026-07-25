// STR-025: ledger-entry document links (Finance & Compliance, "scanned
// documents live in bulk storage and are linked from the corresponding
// ledger entries; documents are immutable once attached; a ledger-linked
// document can never be archived"). The full document registry (title,
// category, upload/archive endpoints) is E12 (M3) and does not exist yet —
// a "document" here is addressed directly by its FileBucket object path,
// verified to exist via the FileBucket itself rather than a registry
// lookup. E12 will mint real registry document_ids later; `isDocumentLinkedToLedger`
// is the archive-blocking guard it must consult once it does.
import { randomUUID } from 'node:crypto';
import { DatabaseErrors, isBlocksError, sql } from '@aws-blocks/blocks';
import type { Database, FileBucket } from '@aws-blocks/blocks';

export interface DocumentLinkResult {
  documentId: string;
  fileName: string;
  linkedAt: string;
}

export interface DocumentLink extends DocumentLinkResult {
  downloadUrl: string;
}

export type DocumentLinkErrorCode = 'entry_not_found' | 'document_not_found' | 'already_linked';

/** Domain rejection for a link attempt — nothing is written when this is thrown. */
export class DocumentLinkError extends Error {
  constructor(message: string, public readonly code: DocumentLinkErrorCode) {
    super(message);
    this.name = 'DocumentLinkError';
  }
}

function fileNameFromPath(documentId: string): string {
  return documentId.split('/').pop() || documentId;
}

/**
 * Link a document (identified by its FileBucket object path) to a journal
 * entry. Rejects — writing nothing — if the entry doesn't exist, if no file
 * exists at that path, or if the document is already linked to this entry
 * (AC1, AC3, TC-FIN-060).
 */
export async function linkDocumentToEntry(
  db: Database,
  bucket: FileBucket,
  entryId: string,
  documentId: string,
): Promise<DocumentLinkResult> {
  const entry = await db.queryOne(sql`SELECT id FROM journal_entries WHERE id = ${entryId}`);
  if (!entry) {
    throw new DocumentLinkError(`No journal entry found with id: ${entryId}`, 'entry_not_found');
  }

  const file = await bucket.get(documentId);
  if (!file) {
    throw new DocumentLinkError(`No document found at: ${documentId}`, 'document_not_found');
  }

  try {
    const row = await db.queryOne<{ linked_at: string }>(
      sql`INSERT INTO journal_entry_documents (id, entry_id, document_path)
          VALUES (${randomUUID()}, ${entryId}, ${documentId})
          RETURNING linked_at::text AS linked_at`,
    );
    return { documentId, fileName: fileNameFromPath(documentId), linkedAt: row!.linked_at };
  } catch (e: unknown) {
    if (isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)) {
      throw new DocumentLinkError(`Document ${documentId} is already linked to entry ${entryId}.`, 'already_linked');
    }
    throw e;
  }
}

/** All documents linked to a journal entry, each resolved to a presigned download URL (TC-FIN-060). */
export async function getDocumentLinksForEntry(db: Database, bucket: FileBucket, entryId: string): Promise<DocumentLink[]> {
  const rows = await db.query<{ document_path: string; linked_at: string }>(
    sql`SELECT document_path, linked_at::text AS linked_at FROM journal_entry_documents WHERE entry_id = ${entryId}`,
  );
  return Promise.all(
    rows.map(async row => ({
      documentId: row.document_path,
      fileName: fileNameFromPath(row.document_path),
      linkedAt: row.linked_at,
      downloadUrl: await bucket.getUrl(row.document_path),
    })),
  );
}

/**
 * The archive-blocking guard (AC2, TC-FIN-061): true iff `documentId` is
 * linked from any ledger entry. E12's document registry must consult this
 * before archiving and return 409 when it is true.
 */
export async function isDocumentLinkedToLedger(db: Database, documentId: string): Promise<boolean> {
  const row = await db.queryOne(sql`SELECT id FROM journal_entry_documents WHERE document_path = ${documentId}`);
  return row !== null;
}

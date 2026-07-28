// STR-124: ticket-scoped attachments -- a photo of the issue or a disputed
// receipt, held in bulk storage and reachable only through the ticket.
//
// The epic's named risk is attachment access leakage ("ticket photos are
// member-private; presigned URLs scoped wrongly would expose them across
// members"). The mitigation shape here is: **presign only after the
// ownership check**, never before. Every early return below happens before
// any bucket call, so a rejected request cannot leak a URL even in an error
// payload.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database, FileBucket } from '@aws-blocks/blocks';
import { TicketValidationError } from './tickets';
import { lockInState, NON_TERMINAL_TICKET_STATUSES } from './lifecycle';
import { TicketLifecycleConflictError } from './lifecycle';
import {
  UPLOAD_URL_EXPIRES_IN_SECONDS,
  DOWNLOAD_URL_EXPIRES_IN_SECONDS,
} from '../documents/documents-api';

export interface AttachmentUploadSlot {
  attachmentId: string;
  uploadUrl: string;
  expiresAt: string;
}

/** `'staff'` stands for any admin login -- ticket handling sits under the
 * general admin roles with no dedicated capability (Member Requests
 * "Surfaces"), so staff are not scoped to the ticket's assignee. */
export type AttachmentRequester = string | 'staff';

/**
 * Mobile `POST /v1/me/tickets/{ticketId}/attachments` (TC-TKT-021, AC1/AC2).
 *
 * Guards before any write or presign: the ticket is non-terminal (STR-122's
 * shared guard -- same rule as a comment or a transition), and the caller is
 * the member who raised it. The row is inserted and the `PUT` presigned in
 * one go; there is no confirm step, matching registerDocument's precedent.
 */
export async function createAttachmentUploadSlot(
  db: Database,
  bucket: FileBucket,
  ticketId: string,
  memberId: string,
  fileName: string,
  mimeType: string,
): Promise<AttachmentUploadSlot> {
  if (!fileName || typeof fileName !== 'string') {
    throw new TicketValidationError('file_name is required.');
  }
  if (!mimeType || typeof mimeType !== 'string') {
    throw new TicketValidationError('mime_type is required.');
  }

  const attachmentId = randomUUID();
  const objectPath = `tickets/${ticketId}/${attachmentId}-${fileName}`;

  await db.transaction(async tx => {
    const ticket = await lockInState(tx, ticketId, NON_TERMINAL_TICKET_STATUSES);
    if (ticket.member_id !== memberId) {
      throw new TicketLifecycleConflictError(`Ticket ${ticketId} was not raised by member ${memberId}.`);
    }
    await tx.execute(
      sql`INSERT INTO ticket_attachments (id, ticket_id, file_name, mime_type, object_path)
          VALUES (${attachmentId}, ${ticketId}, ${fileName}, ${mimeType}, ${objectPath})`,
    );
  });

  const uploadUrl = await bucket.putUrl(objectPath, {
    contentType: mimeType,
    expiresIn: UPLOAD_URL_EXPIRES_IN_SECONDS,
  });
  const expiresAt = new Date(Date.now() + UPLOAD_URL_EXPIRES_IN_SECONDS * 1000).toISOString();

  return { attachmentId, uploadUrl, expiresAt };
}

/**
 * Mobile `GET /v1/me/tickets/{ticketId}/attachments/{attachmentId}` and
 * admin `GET /v1/tickets/{ticketId}/attachments/{attachmentId}`
 * (TC-TKT-022, AC3/AC4). Returns `null` -- never a URL -- whenever the
 * caller is not entitled, so the route 404s cleanly (the getDownloadUrl
 * precedent in documents-api.ts).
 *
 * The lookup keys on **both** `id` and `ticket_id`, so an attachment id
 * cannot be read through a different ticket the caller happens to own:
 * ticket ownership alone is not sufficient, the pairing must hold. That is
 * the concrete form of the epic's leakage mitigation, and the reason this
 * story tests more negative cases than TC-TKT-022's single one.
 *
 * Terminal tickets are readable: the guard blocks *writes* to a closed
 * ticket, not reads of evidence already attached to it.
 */
export async function getAttachmentDownloadUrl(
  db: Database,
  bucket: FileBucket,
  ticketId: string,
  requester: AttachmentRequester,
  attachmentId: string,
): Promise<string | null> {
  const row = await db.queryOne<{ object_path: string; member_id: string }>(
    sql`SELECT a.object_path, t.member_id
        FROM ticket_attachments a
        JOIN tickets t ON t.id = a.ticket_id
        WHERE a.id = ${attachmentId} AND a.ticket_id = ${ticketId}`,
  );
  if (!row) return null;
  if (requester !== 'staff' && row.member_id !== requester) return null;

  return bucket.getUrl(row.object_path, { expiresIn: DOWNLOAD_URL_EXPIRES_IN_SECONDS });
}

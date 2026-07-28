import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Scope, Database, FileBucket, sql } from '@aws-blocks/blocks';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { createMember } from '../../aws-blocks/members/members-api';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { FakePushAdapter } from '../../aws-blocks/notifications/push-adapter';
import { raiseTicket } from '../../aws-blocks/tickets/tickets';
import {
  pickupTicket,
  resolveTicket,
  withdrawTicket,
  autoCloseResolvedTickets,
  TicketLifecycleConflictError,
} from '../../aws-blocks/tickets/lifecycle';
import {
  createAttachmentUploadSlot,
  getAttachmentDownloadUrl,
} from '../../aws-blocks/tickets/attachments';

// STR-124 — ticket-scoped attachments (Member Requests: "ticket-scoped
// files in bulk storage via presigned upload/download — NOT registry
// documents"). Follows the STR-111 test pattern: fresh Database + Scope
// per test, fresh FileBucket per test.

const cleanupDbs: Database[] = [];
const cleanupBuckets: FileBucket[] = [];

async function freshMigratedDb(): Promise<Database> {
  const db = new Database(new Scope(`str-124-test-${randomUUID()}`), 'db');
  cleanupDbs.push(db);
  await runLocalMigrations(db, MIGRATIONS_DIR);
  return db;
}

function freshBucket(): FileBucket {
  const bucket = new FileBucket(new Scope(`str-124-test-${randomUUID()}`), 'documents');
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

async function adminEmployee(db: Database): Promise<string> {
  const employee = await createEmployee(db, { name: `Admin ${randomUUID()}` });
  await setEmployeeCapabilities(db, employee.employee_id, ['finance-recorder']);
  return employee.employee_id;
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe('STR-124 T-U1 — an upload slot is a ticket-scoped bucket object, never a registry document (covers TC-TKT-021)', () => {
  it('creates a ticket_attachments row and returns a presigned PUT under a ticket-prefixed path', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'maintenance', 'Leak', 'Bathroom ceiling leaking.');

    const slot = await createAttachmentUploadSlot(
      db,
      bucket,
      ticket.ticketId,
      member.member_id,
      'leak.jpg',
      'image/jpeg',
    );

    expect(slot.attachmentId).toBeTruthy();
    expect(slot.uploadUrl).toBeTruthy();
    expect(slot.expiresAt).toBeTruthy();

    const row = await db.queryOne<{ ticket_id: string; file_name: string; mime_type: string; object_path: string }>(
      sql`SELECT ticket_id, file_name, mime_type, object_path FROM ticket_attachments WHERE id = ${slot.attachmentId}`,
    );
    expect(row).toMatchObject({
      ticket_id: ticket.ticketId,
      file_name: 'leak.jpg',
      mime_type: 'image/jpeg',
    });
    // AC1: the object path is ticket-scoped, so bucket contents are
    // partitioned by ticket and can never collide with the registry's
    // `documents/` prefix.
    expect(row!.object_path.startsWith(`tickets/${ticket.ticketId}/`)).toBe(true);
  });

  it('writes no row to the document registry (AC1)', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');

    await createAttachmentUploadSlot(db, bucket, ticket.ticketId, member.member_id, 'x.pdf', 'application/pdf');

    expect(await db.query(sql`SELECT id FROM documents`)).toEqual([]);
  });

  it('rejects a missing file_name or mime_type, writing nothing', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');

    await expect(
      createAttachmentUploadSlot(db, bucket, ticket.ticketId, member.member_id, '', 'image/jpeg'),
    ).rejects.toThrow();
    await expect(
      createAttachmentUploadSlot(db, bucket, ticket.ticketId, member.member_id, 'x.jpg', ''),
    ).rejects.toThrow();

    expect(await db.query(sql`SELECT id FROM ticket_attachments`)).toEqual([]);
  });

  it('rejects an upload slot requested by a member who does not own the ticket', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const other = await createMember(db, { name: 'Bhavna Shah' });
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');

    await expect(
      createAttachmentUploadSlot(db, bucket, ticket.ticketId, other.member_id, 'x.jpg', 'image/jpeg'),
    ).rejects.toBeInstanceOf(TicketLifecycleConflictError);

    expect(await db.query(sql`SELECT id FROM ticket_attachments`)).toEqual([]);
  });
});

describe('STR-124 T-U2 — a terminal ticket accepts no upload slot', () => {
  async function closedTicket(db: Database, memberId: string, staff: string): Promise<string> {
    const now = new Date('2026-08-01T00:00:00.000Z');
    const ticket = await raiseTicket(db, memberId, 'general', 'Query', 'Details.');
    await pickupTicket(db, ticket.ticketId, staff);
    await resolveTicket(db, ticket.ticketId, staff, 'Answered.', new FakePushAdapter());
    await db.execute(
      sql`UPDATE tickets SET resolved_at = ${new Date(now.getTime() - 7 * DAY_MS).toISOString()} WHERE id = ${ticket.ticketId}`,
    );
    await autoCloseResolvedTickets(db, now);
    return ticket.ticketId;
  }

  it('rejects an upload slot on a closed ticket, creating no row', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db);
    const ticketId = await closedTicket(db, member.member_id, staff);

    await expect(
      createAttachmentUploadSlot(db, bucket, ticketId, member.member_id, 'late.jpg', 'image/jpeg'),
    ).rejects.toBeInstanceOf(TicketLifecycleConflictError);

    expect(await db.query(sql`SELECT id FROM ticket_attachments`)).toEqual([]);
  });

  it('rejects an upload slot on a withdrawn ticket, creating no row', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    await withdrawTicket(db, ticket.ticketId, member.member_id);

    await expect(
      createAttachmentUploadSlot(db, bucket, ticket.ticketId, member.member_id, 'late.jpg', 'image/jpeg'),
    ).rejects.toBeInstanceOf(TicketLifecycleConflictError);

    expect(await db.query(sql`SELECT id FROM ticket_attachments`)).toEqual([]);
  });
});

describe('STR-124 T-U3 — download presigning happens only after the ownership check (covers TC-TKT-022)', () => {
  it('the ticket owner gets a presigned URL for their own attachment', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    const slot = await createAttachmentUploadSlot(
      db, bucket, ticket.ticketId, member.member_id, 'x.jpg', 'image/jpeg',
    );

    const url = await getAttachmentDownloadUrl(db, bucket, ticket.ticketId, member.member_id, slot.attachmentId);

    expect(url).toBeTruthy();
  });

  it('a different member gets nothing for the same attachment — the epic\'s named leakage risk', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const other = await createMember(db, { name: 'Bhavna Shah' });
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    const slot = await createAttachmentUploadSlot(
      db, bucket, ticket.ticketId, member.member_id, 'x.jpg', 'image/jpeg',
    );

    const url = await getAttachmentDownloadUrl(db, bucket, ticket.ticketId, other.member_id, slot.attachmentId);

    expect(url).toBeNull();
  });

  it('an attachment id belonging to another ticket is not readable through a ticket the caller does own', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const other = await createMember(db, { name: 'Bhavna Shah' });
    const victimTicket = await raiseTicket(db, other.member_id, 'general', 'Theirs', 'Details.');
    const victimSlot = await createAttachmentUploadSlot(
      db, bucket, victimTicket.ticketId, other.member_id, 'secret.jpg', 'image/jpeg',
    );
    const ownTicket = await raiseTicket(db, member.member_id, 'general', 'Mine', 'Details.');

    // The caller owns `ownTicket`, but the attachment belongs to another
    // member's ticket — the pairing must be checked, not just ticket
    // ownership.
    const url = await getAttachmentDownloadUrl(
      db, bucket, ownTicket.ticketId, member.member_id, victimSlot.attachmentId,
    );

    expect(url).toBeNull();
  });

  it('returns null for an unknown attachment id', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');

    const url = await getAttachmentDownloadUrl(db, bucket, ticket.ticketId, member.member_id, randomUUID());

    expect(url).toBeNull();
  });
});

describe('STR-124 T-U4 — staff download any ticket\'s attachments regardless of assignee', () => {
  it('staff get a presigned URL for a ticket they are not assigned to', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const assignee = await adminEmployee(db);
    const otherStaff = await adminEmployee(db);
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    await pickupTicket(db, ticket.ticketId, assignee, assignee);
    const slot = await createAttachmentUploadSlot(
      db, bucket, ticket.ticketId, member.member_id, 'x.jpg', 'image/jpeg',
    );

    const url = await getAttachmentDownloadUrl(db, bucket, ticket.ticketId, 'staff', slot.attachmentId);

    expect(url).toBeTruthy();
    expect(otherStaff).toBeTruthy();
  });

  it('staff still get nothing for an attachment that belongs to a different ticket', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const ticketA = await raiseTicket(db, member.member_id, 'general', 'A', 'a');
    const ticketB = await raiseTicket(db, member.member_id, 'general', 'B', 'b');
    const slotA = await createAttachmentUploadSlot(
      db, bucket, ticketA.ticketId, member.member_id, 'a.jpg', 'image/jpeg',
    );

    const url = await getAttachmentDownloadUrl(db, bucket, ticketB.ticketId, 'staff', slotA.attachmentId);

    expect(url).toBeNull();
  });

  it('staff may download an attachment on a closed ticket — the terminal guard blocks writes, not reads', async () => {
    const db = await freshMigratedDb();
    const bucket = freshBucket();
    const member = await createMember(db, { name: 'Asha Rao' });
    const staff = await adminEmployee(db);
    const ticket = await raiseTicket(db, member.member_id, 'general', 'Query', 'Details.');
    const slot = await createAttachmentUploadSlot(
      db, bucket, ticket.ticketId, member.member_id, 'x.jpg', 'image/jpeg',
    );
    await withdrawTicket(db, ticket.ticketId, member.member_id);

    const url = await getAttachmentDownloadUrl(db, bucket, ticket.ticketId, 'staff', slot.attachmentId);

    expect(url).toBeTruthy();
    expect(staff).toBeTruthy();
  });
});

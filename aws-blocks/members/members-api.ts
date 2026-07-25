// STR-031: the member registry's business logic, sitting between the
// `members` table (migrations/005_members_projects.sql) and the HTTP layer
// (aws-blocks/members/members-routes.ts) -- kept separate so it's testable
// with a plain Database, no HTTP dispatch required (test/members/
// members-api.test.ts). Mirrors the finance/books-api.ts + finance/
// books-routes.ts split.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';

export type MemberStatus = 'pending' | 'active' | 'suspended' | 'ceased';

/** The Admin OpenAPI's Member shape (components/schemas/Member), restricted
 * to the brief's attributes this story owns -- roles/whatsapp_opt_in/
 * cessation_reason belong to later M1 stories. */
export interface Member {
  member_id: string;
  name: string;
  member_status: MemberStatus;
  joining_date: string | null;
  email?: string;
  phone?: string;
  address?: string;
}

/** The Admin OpenAPI's MemberInput shape. member_status/joining_date are
 * intentionally not writable through this type -- see createMember and
 * updateMember below. */
export interface MemberInput {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
}

/** Domain rejection for a PATCH that tries to write a lifecycle-only field.
 * Nothing is written when this is thrown. */
export class MemberValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemberValidationError';
  }
}

interface MemberRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  // The local Blocks Database mock returns DATE columns as JS Date objects,
  // not strings -- toMember below formats to the OpenAPI's plain
  // YYYY-MM-DD date string.
  joining_date: string | Date | null;
  member_status: MemberStatus;
}

function toMember(row: MemberRow): Member {
  const member: Member = {
    member_id: row.id,
    name: row.name,
    member_status: row.member_status,
    joining_date: row.joining_date instanceof Date ? row.joining_date.toISOString().slice(0, 10) : row.joining_date,
  };
  if (row.email !== null) member.email = row.email;
  if (row.phone !== null) member.phone = row.phone;
  if (row.address !== null) member.address = row.address;
  return member;
}

/**
 * `POST /members` -- new members always enter as `pending` with no
 * `joining_date` (Domain Model, "Member status lifecycle"): any
 * caller-supplied `member_status`/`joining_date` is ignored, since neither
 * is part of `MemberInput` here -- only the (not yet built) lifecycle
 * transition function (STR-032) writes those.
 */
export async function createMember(db: Database, input: MemberInput): Promise<Member> {
  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO members (id, name, email, phone, address)
        VALUES (${id}, ${input.name ?? null}, ${input.email ?? null}, ${input.phone ?? null}, ${input.address ?? null})`,
  );
  const member = await getMember(db, id);
  return member!;
}

/** `GET /members/{memberId}` -- a single member, or `null` if it doesn't exist. */
export async function getMember(db: Database, memberId: string): Promise<Member | null> {
  const row = await db.queryOne<MemberRow>(sql`SELECT * FROM members WHERE id = ${memberId}`);
  return row ? toMember(row) : null;
}

export interface ListMembersOptions {
  status?: MemberStatus;
}

/** `GET /members` -- every member, optionally filtered to a single `member_status`. */
export async function listMembers(db: Database, options: ListMembersOptions = {}): Promise<Member[]> {
  const rows = options.status
    ? await db.query<MemberRow>(sql`SELECT * FROM members WHERE member_status = ${options.status} ORDER BY id`)
    : await db.query<MemberRow>(sql`SELECT * FROM members ORDER BY id`);
  return rows.map(toMember);
}

/**
 * `PATCH /members/{memberId}` -- updates the brief's editable attributes.
 * Rejects -- writing nothing -- a request carrying `member_status`,
 * regardless of the value it holds: status moves only through the
 * lifecycle transition function (STR-032), never a raw PATCH (this epic's
 * pinned business rule). Returns `null` if the member doesn't exist.
 */
export async function updateMember(db: Database, memberId: string, input: MemberInput & { member_status?: unknown }): Promise<Member | null> {
  if ('member_status' in input) {
    throw new MemberValidationError('member_status cannot be set by PATCH; it changes only through lifecycle actions.');
  }

  const existing = await getMember(db, memberId);
  if (!existing) return null;

  await db.execute(
    sql`UPDATE members SET
          name = ${input.name ?? existing.name},
          email = ${input.email ?? existing.email ?? null},
          phone = ${input.phone ?? existing.phone ?? null},
          address = ${input.address ?? existing.address ?? null}
        WHERE id = ${memberId}`,
  );
  return getMember(db, memberId);
}

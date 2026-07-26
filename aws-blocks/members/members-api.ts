// STR-031: the member registry's business logic, sitting between the
// `members` table (migrations/005_members_projects.sql) and the HTTP layer
// (aws-blocks/members/members-routes.ts) -- kept separate so it's testable
// with a plain Database, no HTTP dispatch required (test/members/
// members-api.test.ts). Mirrors the finance/books-api.ts + finance/
// books-routes.ts split.
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { ValidationError, ConflictError } from '../http/problem-response';

export type MemberStatus = 'pending' | 'active' | 'suspended' | 'ceased';

/** The Domain Model's decided cessation reason enum -- required exactly once, on cessation. */
export type CessationReason = 'resigned' | 'expelled' | 'deceased' | 'transferred';
const CESSATION_REASONS: readonly CessationReason[] = ['resigned', 'expelled', 'deceased', 'transferred'];

/**
 * STR-032: the decided lifecycle edge set (Domain Model, "Member status
 * lifecycle") -- `pending -> active`, `active <-> suspended`, and both
 * non-terminal states into terminal `ceased`. Cessation transitions are
 * listed here (the full machine) but not wired to an endpoint until
 * STR-033.
 */
export const MEMBER_STATUS_TRANSITIONS: ReadonlyArray<readonly [MemberStatus, MemberStatus]> = [
  ['pending', 'active'],
  ['active', 'suspended'],
  ['suspended', 'active'],
  ['active', 'ceased'],
  ['suspended', 'ceased'],
];

/** Pure edge-set membership check -- the single source of truth for which transitions are permitted. */
export function canTransitionMemberStatus(from: MemberStatus, to: MemberStatus): boolean {
  return MEMBER_STATUS_TRANSITIONS.some(([edgeFrom, edgeTo]) => edgeFrom === from && edgeTo === to);
}

/** The Admin OpenAPI's Member shape (components/schemas/Member), restricted
 * to the brief's attributes this story owns -- roles/whatsapp_opt_in/
 * cessation_reason belong to later M1 stories. */
export interface Member {
  member_id: string;
  name: string;
  member_status: MemberStatus;
  joining_date: string | null;
  cessation_reason: CessationReason | null;
  email?: string;
  phone?: string;
  address?: string;
}

/** The Admin OpenAPI's MemberInput shape. member_status/joining_date are
 * intentionally not writable through this type -- see createMember and
 * updateMember below. */
export interface MemberInput {
  name?: string;
  email?: string | null;
  phone?: string | null;
  address?: string | null;
}

/** Domain rejection for a PATCH that tries to write a lifecycle-only field.
 * Nothing is written when this is thrown. */
export class MemberValidationError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'MemberValidationError';
  }
}

/** Domain rejection for a lifecycle action attempted from the wrong current
 * status (e.g. suspending a pending member). Nothing is written when this
 * is thrown. */
export class MemberLifecycleConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'MemberLifecycleConflictError';
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
  cessation_reason: CessationReason | null;
  // Who performed the last suspend/reinstate (STR-032) -- not part of the
  // public Member shape (the OpenAPI schema doesn't expose it), recorded
  // for audit only.
  status_actor: string | null;
  // When the last actor-scoped transition (suspend/reinstate) happened
  // (STR-032 code review) -- same audit-only scoping as status_actor, not
  // part of the public Member shape.
  status_changed_at: string | Date | null;
}

function toMember(row: MemberRow): Member {
  const member: Member = {
    member_id: row.id,
    name: row.name,
    member_status: row.member_status,
    joining_date: row.joining_date instanceof Date ? row.joining_date.toISOString().slice(0, 10) : row.joining_date,
    cessation_reason: row.cessation_reason,
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
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new MemberValidationError('name is required.');
  }

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
          email = ${'email' in input ? input.email ?? null : existing.email ?? null},
          phone = ${'phone' in input ? input.phone ?? null : existing.phone ?? null},
          address = ${'address' in input ? input.address ?? null : existing.address ?? null}
        WHERE id = ${memberId}`,
  );
  return getMember(db, memberId);
}

interface TransitionMemberStatusOptions {
  actor?: string;
  setJoiningDate?: boolean;
  cessationReason?: CessationReason;
}

/**
 * STR-032 Refactor: the payload emitted after every successful
 * member_status write. Lets E05 (role vacation) and E07 (accrual
 * eligibility) hook in without coupling to endpoint code -- neither exists
 * yet, so there is nothing wired to this beyond the array below.
 */
export interface MemberStatusTransitionEvent {
  memberId: string;
  from: MemberStatus;
  to: MemberStatus;
  actor?: string;
}

/** Listeners called synchronously by transitionMemberStatus after its DB
 * write succeeds. A future consumer registers with
 * `memberStatusTransitionListeners.push(fn)` -- no persistence, retries, or
 * async dispatch here; that's this seam's whole job. */
export const memberStatusTransitionListeners: Array<(event: MemberStatusTransitionEvent) => void> = [];

/**
 * STR-032: the only writer of `member_status` -- every lifecycle action
 * (admitMember, suspendMember, reinstateMember, and STR-033's future
 * cessation) delegates here rather than writing the column directly (AC3).
 * Rejects -- writing nothing -- if the member isn't currently in `from`, or
 * `from -> to` isn't in the decided edge set (MEMBER_STATUS_TRANSITIONS).
 */
async function transitionMemberStatus(
  db: Database,
  memberId: string,
  from: MemberStatus,
  to: MemberStatus,
  opts: TransitionMemberStatusOptions = {},
): Promise<Member | null> {
  const existing = await db.queryOne<MemberRow>(sql`SELECT * FROM members WHERE id = ${memberId}`);
  if (!existing) return null;

  const conflictError = () =>
    new MemberLifecycleConflictError(
      `Member ${memberId} is ${existing.member_status}; cannot transition to ${to} (expected ${from}).`,
    );

  if (existing.member_status !== from || !canTransitionMemberStatus(from, to)) {
    throw conflictError();
  }

  const statusActor = opts.actor ?? existing.status_actor ?? null;
  // Timestamp of the last actor-scoped transition (STR-032 code review) --
  // same scoping as statusActor: only suspend/reinstate (opts.actor set)
  // touch it, admission leaves it as-is.
  const statusChangedAt = opts.actor ? new Date() : existing.status_changed_at;

  // The AND member_status = ${from} guard (and the rowCount check below) is
  // a DB-level backstop for the SELECT-then-UPDATE race above: two
  // concurrent calls can both pass the app-level check before either
  // commits its UPDATE, so the WHERE clause itself must re-verify `from`.
  // Only the first to commit affects a row; the second's UPDATE matches
  // nothing and rowCount is 0.
  const { rowCount } = opts.setJoiningDate
    ? await db.execute(
        sql`UPDATE members SET member_status = ${to}, status_actor = ${statusActor}, status_changed_at = ${statusChangedAt}, joining_date = (now() AT TIME ZONE 'Asia/Kolkata')::date WHERE id = ${memberId} AND member_status = ${from}`,
      )
    : opts.cessationReason
      ? await db.execute(
          sql`UPDATE members SET member_status = ${to}, status_actor = ${statusActor}, status_changed_at = ${statusChangedAt}, cessation_reason = ${opts.cessationReason} WHERE id = ${memberId} AND member_status = ${from}`,
        )
      : await db.execute(
          sql`UPDATE members SET member_status = ${to}, status_actor = ${statusActor}, status_changed_at = ${statusChangedAt} WHERE id = ${memberId} AND member_status = ${from}`,
        );

  if (rowCount === 0) {
    throw conflictError();
  }

  for (const listener of memberStatusTransitionListeners) {
    listener({ memberId, from, to, actor: opts.actor });
  }

  return getMember(db, memberId);
}

/**
 * `POST /members/{memberId}/admit` -- admits a pending member (Domain
 * Model, "Member status lifecycle"), setting `joining_date` to today's IST
 * calendar date. No actor is recorded (not an EC action). Returns `null` if
 * the member doesn't exist; throws `MemberLifecycleConflictError` if the
 * member isn't currently `pending`.
 */
export async function admitMember(db: Database, memberId: string): Promise<Member | null> {
  return transitionMemberStatus(db, memberId, 'pending', 'active', { setJoiningDate: true });
}

function requireActor(actor: unknown): string {
  if (typeof actor !== 'string' || actor.trim() === '') {
    throw new MemberValidationError('actor is required.');
  }
  return actor;
}

/**
 * `POST /members/{memberId}/suspend` -- the EC suspends an active member.
 * Requires `actor` (the acting EC member), validated before any DB read.
 * Returns `null` if the member doesn't exist; throws
 * `MemberLifecycleConflictError` if the member isn't currently `active`.
 */
export async function suspendMember(db: Database, memberId: string, actor: unknown): Promise<Member | null> {
  const validActor = requireActor(actor);
  return transitionMemberStatus(db, memberId, 'active', 'suspended', { actor: validActor });
}

/**
 * `POST /members/{memberId}/reinstate` -- the EC reinstates a suspended
 * member. Same actor/status-conflict rules as suspendMember, but the
 * expected `from` is `suspended` -- admission and reinstatement both target
 * `active`, but from different source statuses, so they stay two distinct
 * wrappers rather than one that infers `from` from the DB.
 */
export async function reinstateMember(db: Database, memberId: string, actor: unknown): Promise<Member | null> {
  const validActor = requireActor(actor);
  return transitionMemberStatus(db, memberId, 'suspended', 'active', { actor: validActor });
}

function requireCessationReason(reason: unknown): CessationReason {
  if (typeof reason !== 'string' || !(CESSATION_REASONS as readonly string[]).includes(reason)) {
    throw new MemberValidationError('cessation_reason is required and must be one of resigned, expelled, deceased, transferred.');
  }
  return reason as CessationReason;
}

/**
 * STR-033: reports whether a member currently holds any ownerships. A
 * narrow lookup port rather than a direct table query -- E06 hasn't shipped
 * the real ownership store yet, so ceaseMember below depends only on this
 * signature.
 */
export type OwnershipLookupPort = (db: Database, memberId: string) => Promise<boolean>;

/** Stub until E06: always reports no ownerships held, so cessation is never blocked by default. */
export const stubMemberHoldsOwnerships: OwnershipLookupPort = async () => false;

interface CeaseMemberOptions {
  ownershipLookup?: OwnershipLookupPort;
}

/**
 * `POST /members/{memberId}/cease` (not yet wired to an endpoint -- this
 * story is business logic only) -- ends an active or suspended member's
 * membership (Domain Model, "ceased ... terminal"). Requires a valid
 * cessation_reason (AC1), validated before any DB read. Every reason except
 * `deceased` is blocked while the ownership-lookup port reports ownerships
 * held (AC2); `deceased` retains them pending succession. Returns `null` if
 * the member doesn't exist; throws `MemberLifecycleConflictError` if the
 * member isn't currently `active` or `suspended` -- including an
 * already-`ceased` member, since `ceased -> ceased` isn't in the decided
 * edge set (AC3).
 */
export async function ceaseMember(db: Database, memberId: string, reason: unknown, opts: CeaseMemberOptions = {}): Promise<Member | null> {
  const cessationReason = requireCessationReason(reason);
  const existing = await getMember(db, memberId);
  if (!existing) return null;

  if (cessationReason !== 'deceased') {
    const holdsOwnerships = await (opts.ownershipLookup ?? stubMemberHoldsOwnerships)(db, memberId);
    if (holdsOwnerships) {
      throw new MemberLifecycleConflictError(`Member ${memberId} holds ownerships; transfer them before cessation.`);
    }
  }

  return transitionMemberStatus(db, memberId, existing.member_status, 'ceased', { cessationReason });
}

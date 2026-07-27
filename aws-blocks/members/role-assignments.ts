// STR-041: Management/EC role assignments with tenure history (Governance &
// Roles: elections happen offline; the system records assignments as admin
// actions with effective from/to dates -- no election module). Sits beside
// members-api.ts, following the same "business logic only, no HTTP surface"
// shape as STR-034's entitlements.ts -- no OpenAPI path or schema anywhere
// references role assignment.
//
// Invariant chain (EC ⊂ Management ⊂ Members): every EC office bearer must
// hold an open `management` assignment, and every role requires the member
// to currently be `active` (isRoleEligible, STR-034). Suspension/cessation
// vacates all open roles -- see vacateRolesOnStatusChange below.
import { randomUUID } from 'node:crypto';
import { DatabaseErrors, isBlocksError, sql } from '@aws-blocks/blocks';
import type { Database, Transaction } from '@aws-blocks/blocks';
import { ValidationError, ConflictError } from '../http/problem-response';
import { getMember, memberStatusTransitionListeners, type MemberStatusTransitionEvent } from './members-api';
import { isRoleEligible } from './entitlements';

export type ManagementRole = 'management' | 'president' | 'vice_president' | 'general_secretary' | 'treasurer' | 'executive_member';

/** The five EC offices -- each requires an open `management` assignment
 * (subset-chain, AC1). Exported for STR-044's claims builder, which needs
 * to check "does this member currently hold any EC office" without
 * re-deriving the list. */
export const EC_OFFICES: readonly ManagementRole[] = ['president', 'vice_president', 'general_secretary', 'treasurer', 'executive_member'];

export interface RoleAssignment {
  id: string;
  memberId: string;
  role: ManagementRole;
  /** YYYY-MM-DD. */
  effectiveFrom: string;
  /** YYYY-MM-DD, or null while the assignment is open. */
  effectiveTo: string | null;
  actingAdmin: string | null;
}

/** Domain rejection for a role-assignment request that's malformed before
 * any DB write is attempted (member not found, missing effectiveFrom/actingAdmin). */
export class RoleAssignmentValidationError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'RoleAssignmentValidationError';
  }
}

/** Domain rejection for a role-assignment request that's invalid given
 * current state (member not active, subset-chain violation, role already
 * held, or nothing open to vacate). Nothing is written when this is thrown. */
export class RoleAssignmentConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'RoleAssignmentConflictError';
  }
}

interface RoleAssignmentRow {
  id: string;
  member_id: string;
  role: ManagementRole;
  // The local Blocks Database mock returns DATE columns as JS Date objects,
  // not strings -- toRoleAssignment below formats to YYYY-MM-DD, mirroring
  // members-api.ts's toMember.
  effective_from: string | Date;
  effective_to: string | Date | null;
  acting_admin: string | null;
}

function toDateString(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function toRoleAssignment(row: RoleAssignmentRow): RoleAssignment {
  return {
    id: row.id,
    memberId: row.member_id,
    role: row.role,
    effectiveFrom: toDateString(row.effective_from),
    effectiveTo: row.effective_to === null ? null : toDateString(row.effective_to),
    actingAdmin: row.acting_admin,
  };
}

function requireNonBlank(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RoleAssignmentValidationError(`${field} is required.`);
  }
  return value;
}

/**
 * Assigns a role to a member, effective from `effectiveFrom`. Rejects --
 * writing nothing -- if the member doesn't exist (RoleAssignmentValidationError),
 * if the member isn't currently `active` (RoleAssignmentConflictError, AC1),
 * if `role` is an EC office and the member has no open `management`
 * assignment (RoleAssignmentConflictError, subset-chain, AC1), or if the
 * member already holds an open assignment for this exact role
 * (RoleAssignmentConflictError).
 */
export async function assignRole(
  db: Database,
  memberId: string,
  role: ManagementRole,
  effectiveFrom: string,
  actingAdmin: string,
): Promise<RoleAssignment> {
  requireNonBlank(effectiveFrom, 'effectiveFrom');
  requireNonBlank(actingAdmin, 'actingAdmin');

  const member = await getMember(db, memberId);
  if (!member) {
    throw new RoleAssignmentValidationError(`No member found with id: ${memberId}`);
  }

  if (!isRoleEligible(member.member_status)) {
    throw new RoleAssignmentConflictError(`Member ${memberId} is ${member.member_status}; roles require active status.`);
  }

  if (EC_OFFICES.includes(role)) {
    const openManagement = await db.queryOne(
      sql`SELECT id FROM role_assignments WHERE member_id = ${memberId} AND role = 'management' AND effective_to IS NULL`,
    );
    if (!openManagement) {
      throw new RoleAssignmentConflictError(
        `Member ${memberId} must hold an open management assignment before being assigned ${role}.`,
      );
    }
  }

  const id = randomUUID();
  try {
    await db.execute(
      sql`INSERT INTO role_assignments (id, member_id, role, effective_from, acting_admin)
          VALUES (${id}, ${memberId}, ${role}, ${effectiveFrom}::date, ${actingAdmin})`,
    );
  } catch (e: unknown) {
    // role_assignments_open_unique (migrations/013) is the TOCTOU backstop
    // for the SELECT-then-INSERT race above: two concurrent assignments of
    // the same role to the same member can both pass the app-level checks
    // before either commits, so the second INSERT hits the partial unique
    // index instead of succeeding. Same shape as finance/reversal.ts's catch.
    if (isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)) {
      throw new RoleAssignmentConflictError(`Member ${memberId} already holds an open assignment for role ${role}.`);
    }
    throw e;
  }

  const row = await db.queryOne<RoleAssignmentRow>(sql`SELECT * FROM role_assignments WHERE id = ${id}`);
  return toRoleAssignment(row!);
}

/**
 * Closes a member's open assignment for `role` as of `effectiveTo`. Rejects
 * -- writing nothing -- if no open assignment exists for that member/role
 * (RoleAssignmentConflictError).
 */
export async function vacateRole(
  db: Database,
  memberId: string,
  role: ManagementRole,
  effectiveTo: string,
  actingAdmin?: string,
): Promise<RoleAssignment> {
  // RETURNING id captures exactly the row this UPDATE closed -- unlike a
  // post-write re-query on (member_id, role, effective_to), which is
  // ambiguous whenever two same-day assign+vacate cycles for the same
  // member+role leave two closed rows sharing that tuple (id is a random
  // UUID, so ORDER BY id DESC picks an arbitrary one of them, not the one
  // this call just closed).
  const updated = await db.queryOne<{ id: string }>(
    sql`UPDATE role_assignments SET effective_to = ${effectiveTo}::date, acting_admin = COALESCE(${actingAdmin ?? null}, acting_admin)
        WHERE member_id = ${memberId} AND role = ${role} AND effective_to IS NULL
        RETURNING id`,
  );
  if (!updated) {
    throw new RoleAssignmentConflictError(`Member ${memberId} has no open assignment for role ${role} to vacate.`);
  }

  const row = await db.queryOne<RoleAssignmentRow>(sql`SELECT * FROM role_assignments WHERE id = ${updated.id}`);
  return toRoleAssignment(row!);
}

export interface ListRoleAssignmentsOptions {
  memberId?: string;
  role?: ManagementRole;
}

/** Every role_assignments row (open and closed) matching the given filters,
 * ordered by effective_from -- the queryable tenure history (AC3). */
export async function listRoleAssignments(db: Database, options: ListRoleAssignmentsOptions = {}): Promise<RoleAssignment[]> {
  const rows = await db.query<RoleAssignmentRow>(
    options.memberId && options.role
      ? sql`SELECT * FROM role_assignments WHERE member_id = ${options.memberId} AND role = ${options.role} ORDER BY effective_from`
      : options.memberId
        ? sql`SELECT * FROM role_assignments WHERE member_id = ${options.memberId} ORDER BY effective_from`
        : options.role
          ? sql`SELECT * FROM role_assignments WHERE role = ${options.role} ORDER BY effective_from`
          : sql`SELECT * FROM role_assignments ORDER BY effective_from`,
  );
  return rows.map(toRoleAssignment);
}

/**
 * STR-032 status-transition listener: leaving `active` (suspension or
 * cessation) vacates every role the member currently holds open, as of
 * today's IST calendar date, in the same transaction as the member's status
 * UPDATE (AC2). Registering this at module load -- a side effect of
 * importing role-assignments.ts -- is deliberate: it's what "hooks in" role
 * vacation, rather than members-api.ts depending on this module directly.
 */
async function vacateRolesOnStatusChange(event: MemberStatusTransitionEvent, tx: Transaction): Promise<void> {
  if (event.to === 'active') return; // only suspension/cessation vacate roles
  await tx.execute(
    sql`UPDATE role_assignments SET effective_to = (now() AT TIME ZONE 'Asia/Kolkata')::date
        WHERE member_id = ${event.memberId} AND effective_to IS NULL`,
  );
}

memberStatusTransitionListeners.push(vacateRolesOnStatusChange);

/**
 * STR-075: the printed name for the currently-open `treasurer` role
 * assignment -- receipts attribute to whoever holds the office live, not a
 * separately configured name. Returns `null` if the office is currently
 * vacant (no open assignment).
 */
export async function getCurrentTreasurerName(db: Database): Promise<string | null> {
  const assignments = await listRoleAssignments(db, { role: 'treasurer' });
  const open = assignments.find(assignment => assignment.effectiveTo === null);
  if (!open) return null;

  const member = await getMember(db, open.memberId);
  return member ? member.name : null;
}

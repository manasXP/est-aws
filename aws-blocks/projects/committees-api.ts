// STR-043: Project committee (PC) appointment and composition, on the
// STR-041 tenure-history pattern (aws-blocks/members/role-assignments.ts --
// not yet merged as of this story, so the pattern is replicated into its
// own tables/module rather than imported). Sits beside projects-api.ts,
// same business-logic/HTTP-adapter split (aws-blocks/projects/
// committees-routes.ts). Governance & Roles: flat membership with a single
// designated Chair; every seat holder -- chair included -- must be an
// `active` member holding an ownership in that project; at most one PC per
// project; a member may sit on several PCs.
import { randomUUID } from 'node:crypto';
import { DatabaseErrors, isBlocksError, sql } from '@aws-blocks/blocks';
import type { Database, Transaction } from '@aws-blocks/blocks';
import { ValidationError, ConflictError } from '../http/problem-response';
import { getProject } from './projects-api';
import { getMember, memberStatusTransitionListeners, type MemberStatusTransitionEvent } from '../members/members-api';
import { isRoleEligible } from '../members/entitlements';

/** The Admin OpenAPI's ProjectCommittee shape (components/schemas/ProjectCommittee). */
export interface ProjectCommittee {
  project_id: string;
  /** Null when no PC has been appointed (or every seat has been vacated). */
  chair_member_id: string | null;
  member_ids: string[];
  /** ISO date-time, or null alongside an unappointed/fully-vacated PC. */
  updated_at: string | null;
}

/** The PUT /v1/projects/{projectId}/committee request body. */
export interface SetProjectCommitteeInput {
  chair_member_id: string;
  member_ids: string[];
}

/**
 * Project-scoped in-project-ownership lookup port -- distinct from
 * members-api.ts's `OwnershipLookupPort` (STR-033), which answers a
 * different, non-project-scoped question ("does this member hold any
 * ownership at all") for cessation, with the opposite-shaped default. E06's
 * asset/ownership registry doesn't exist yet, so appointment depends only
 * on this signature until then.
 */
export type ProjectOwnershipLookupPort = (db: Database, memberId: string, projectId: string) => Promise<boolean>;

/** Stub until E06: no member owns in any project, so every appointment
 * attempt is rejected by default until a real port is wired in. */
export const stubMemberOwnsInProject: ProjectOwnershipLookupPort = async () => false;

/**
 * Domain rejection for creating a second PC for a project that already has
 * one (project_committees.project_id UNIQUE, AC2, TC-MEM-041) -- an
 * internal invariant of the low-level createCommittee below. The public
 * getOrCreateCommittee/setProjectCommittee path is idempotent and never
 * lets this surface through the PUT endpoint.
 */
export class CommitteeConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = 'CommitteeConflictError';
  }
}

/**
 * Domain rejection for a PUT listing a member who isn't `active` or doesn't
 * hold an ownership in the project (OpenAPI: 422 pc_member_ineligible).
 * Extends ValidationError, not ConflictError: problem-response.ts maps
 * ValidationError -> sendValidationError (422) and ConflictError ->
 * sendConflictError (409), and the spec requires 422 here. Nothing is
 * written when this is thrown (validated before any write).
 */
export class CommitteeEligibilityError extends ValidationError {
  constructor(message: string) {
    super(message);
    this.name = 'CommitteeEligibilityError';
  }
}

interface CommitteeRow {
  id: string;
  project_id: string;
  updated_at: string | Date | null;
}

interface SeatRow {
  id: string;
  committee_id: string;
  member_id: string;
  is_chair: boolean;
  effective_from: string | Date;
  effective_to: string | Date | null;
}

function toIsoDateTime(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Raw insert of a new committee row for `projectId`. Throws
 * `CommitteeConflictError` -- catching `project_committees`'s `project_id`
 * UNIQUE constraint -- if one already exists (AC2, TC-MEM-041). Does not
 * itself check whether the project exists; `getOrCreateCommittee` does that
 * via `getProject` before calling this.
 */
export async function createCommittee(db: Database, projectId: string): Promise<{ id: string; project_id: string }> {
  const id = randomUUID();
  try {
    await db.execute(sql`INSERT INTO project_committees (id, project_id) VALUES (${id}, ${projectId})`);
  } catch (e: unknown) {
    // project_committees_project_id_key (migrations/012) is the TOCTOU
    // backstop for the SELECT-then-INSERT race in getOrCreateCommittee: two
    // concurrent get-or-creates for the same project can both pass its
    // SELECT before either commits, so the second INSERT hits the unique
    // constraint instead of succeeding. Same shape as finance/reversal.ts's
    // catch.
    if (isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)) {
      throw new CommitteeConflictError(`Project ${projectId} already has a committee.`);
    }
    throw e;
  }
  return { id, project_id: projectId };
}

/**
 * Returns the existing committee row for `projectId`, or creates one.
 * Retries once by re-selecting if `createCommittee` loses the create race
 * (`CommitteeConflictError`) -- the winner's row is returned either way.
 * Returns `null` if no project exists with that id (checked via
 * `getProject` rather than duplicating the query).
 */
export async function getOrCreateCommittee(db: Database, projectId: string): Promise<{ id: string; project_id: string } | null> {
  const project = await getProject(db, projectId);
  if (!project) return null;

  const existing = await db.queryOne<{ id: string; project_id: string }>(
    sql`SELECT id, project_id FROM project_committees WHERE project_id = ${projectId}`,
  );
  if (existing) return existing;

  try {
    return await createCommittee(db, projectId);
  } catch (e: unknown) {
    if (e instanceof CommitteeConflictError) {
      return db.queryOne<{ id: string; project_id: string }>(
        sql`SELECT id, project_id FROM project_committees WHERE project_id = ${projectId}`,
      );
    }
    throw e;
  }
}

/**
 * `GET /projects/{projectId}/committee` -- the project's current PC
 * composition. Returns `null` if no project exists with that id (-> 404 at
 * the route layer). Returns the "unappointed" shape (`chair_member_id:
 * null, member_ids: []`) both when no committee row exists yet and when one
 * exists but currently has zero open seats (fully dissolved).
 */
export async function getProjectCommittee(db: Database, projectId: string): Promise<ProjectCommittee | null> {
  const project = await getProject(db, projectId);
  if (!project) return null;

  const committee = await db.queryOne<CommitteeRow>(sql`SELECT * FROM project_committees WHERE project_id = ${projectId}`);
  if (!committee) {
    return { project_id: projectId, chair_member_id: null, member_ids: [], updated_at: null };
  }

  const seats = await db.query<SeatRow>(
    sql`SELECT * FROM project_committee_seats WHERE committee_id = ${committee.id} AND effective_to IS NULL`,
  );
  if (seats.length === 0) {
    return { project_id: projectId, chair_member_id: null, member_ids: [], updated_at: null };
  }

  const chairSeat = seats.find(seat => seat.is_chair);
  return {
    project_id: projectId,
    chair_member_id: chairSeat ? chairSeat.member_id : null,
    member_ids: seats.map(seat => seat.member_id),
    updated_at: committee.updated_at === null ? null : toIsoDateTime(committee.updated_at),
  };
}

interface SetProjectCommitteeOptions {
  ownershipLookup?: ProjectOwnershipLookupPort;
}

/**
 * `PUT /projects/{projectId}/committee` -- replaces the PC composition
 * (EC action). Returns `null` if the project doesn't exist (-> 404).
 * Validates before any write (write-nothing-on-rejection): `chair_member_id`
 * must be included in `member_ids`, and every id in `member_ids` must
 * resolve to a real member who is currently `active`
 * (`isRoleEligible`, STR-034) and passes `ownershipLookup` (default
 * `stubMemberOwnsInProject`, so every appointment is rejected until a real
 * port is wired in E06) -- otherwise throws `CommitteeEligibilityError`.
 * Then closes every currently-open seat and opens a fresh one for each id
 * in `member_ids` ("close everything, reopen the new set" -- deliberately
 * not a member-by-member diff), all in one transaction.
 */
export async function setProjectCommittee(
  db: Database,
  projectId: string,
  input: SetProjectCommitteeInput,
  opts: SetProjectCommitteeOptions = {},
): Promise<ProjectCommittee | null> {
  const project = await getProject(db, projectId);
  if (!project) return null;

  const memberIds = input.member_ids;
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    throw new CommitteeEligibilityError('member_ids must be a non-empty array.');
  }
  if (typeof input.chair_member_id !== 'string' || input.chair_member_id.trim() === '') {
    throw new CommitteeEligibilityError('chair_member_id is required.');
  }
  if (!memberIds.includes(input.chair_member_id)) {
    throw new CommitteeEligibilityError(`chair_member_id ${input.chair_member_id} must be included in member_ids.`);
  }

  const ownershipLookup = opts.ownershipLookup ?? stubMemberOwnsInProject;
  for (const memberId of memberIds) {
    const member = await getMember(db, memberId);
    if (!member || !isRoleEligible(member.member_status)) {
      throw new CommitteeEligibilityError(`Member ${memberId} must be an active member to sit on the PC.`);
    }
    if (!(await ownershipLookup(db, memberId, projectId))) {
      throw new CommitteeEligibilityError(`Member ${memberId} does not hold an ownership in project ${projectId}.`);
    }
  }

  // The committee row's own creation is idempotent (getOrCreateCommittee
  // retries on a lost create race), so it doesn't need to share the seat
  // transaction below -- only the close-then-reopen seat replacement needs
  // that atomicity.
  const committee = await getOrCreateCommittee(db, projectId);
  if (!committee) return null; // unreachable: existence already confirmed above

  await db.transaction(async tx => {
    await tx.execute(
      sql`UPDATE project_committee_seats SET effective_to = (now() AT TIME ZONE 'Asia/Kolkata')::date
          WHERE committee_id = ${committee.id} AND effective_to IS NULL`,
    );
    for (const memberId of memberIds) {
      await tx.execute(
        sql`INSERT INTO project_committee_seats (id, committee_id, member_id, is_chair, effective_from)
            VALUES (${randomUUID()}, ${committee.id}, ${memberId}, ${memberId === input.chair_member_id}, (now() AT TIME ZONE 'Asia/Kolkata')::date)`,
      );
    }
    await tx.execute(sql`UPDATE project_committees SET updated_at = now() WHERE id = ${committee.id}`);
  });

  return getProjectCommittee(db, projectId);
}

/**
 * STR-043 status-transition listener (T-U4): leaving `active` (suspension
 * or cessation) closes every open PC seat the member currently holds,
 * across all committees, as of today's IST calendar date, in the same
 * transaction as the member's status UPDATE -- same shape as
 * role-assignments.ts's `vacateRolesOnStatusChange`. The ownership-transfer
 * half of seat vacation (vacate when a member transfers away their last
 * in-project ownership) is out of scope until E06 (story Dependencies).
 */
async function vacateCommitteeSeatsOnStatusChange(event: MemberStatusTransitionEvent, tx: Transaction): Promise<void> {
  if (event.to === 'active') return; // only suspension/cessation vacate seats
  await tx.execute(
    sql`UPDATE project_committee_seats SET effective_to = (now() AT TIME ZONE 'Asia/Kolkata')::date
        WHERE member_id = ${event.memberId} AND effective_to IS NULL`,
  );
}

memberStatusTransitionListeners.push(vacateCommitteeSeatsOnStatusChange);

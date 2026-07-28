// STR-044: JWT role claims mapped to Governance & Roles capabilities, and
// the single authorization decision every protected Admin API endpoint
// gates on (aws-blocks/http/capability-gate.ts is the HTTP-layer adapter
// over this module -- pure business logic here, no request/response
// concerns, same split as members-api.ts/members-routes.ts).
//
// Real JWT issuance itself is out of this story's scope (Dependencies:
// "comes from the E01 walking skeleton's auth spike", which doesn't exist
// yet) -- this module derives capabilities from an already-identified
// actor (a member or an employee id); the HTTP layer's job is turning a
// request into that actor id.
import { sql } from '@aws-blocks/blocks';
import type { Database } from '@aws-blocks/blocks';
import { getEmployee } from '../employees/employees-api';
import { listRoleAssignments, EC_OFFICES } from './role-assignments';

/**
 * The Admin API's capability registry (Admin Panel API: "Verification
 * requires designated-verifier; approval the designated-approver (EC)
 * capability; money-posting endpoints the finance-recorder capability").
 * PC seats confer none of these (Governance & Roles: "no dedicated admin
 * capability in v1") -- deliberately absent from this list and never
 * checked against project_committee_seats anywhere below.
 */
export type GovernanceCapability =
  | 'designated-verifier'
  | 'designated-approver'
  | 'finance-recorder'
  // STR-132: the two Communication capabilities -- composing on the society
  // board (EC only) and moderating any board (Management or EC). Both derive
  // from current role assignments with no designation table of their own,
  // the way finance-recorder already defaults off the Treasurer's role.
  | 'bulletin_compose'
  | 'bulletin_moderate';

export const GOVERNANCE_CAPABILITIES: readonly GovernanceCapability[] = [
  'designated-verifier',
  'designated-approver',
  'finance-recorder',
  'bulletin_compose',
  'bulletin_moderate',
];

/** Who the claims are being built for -- exactly one of a member or an employee identity. */
export type Actor = { memberId: string } | { employeeId: string };

/**
 * Adds `memberId` to the designated-approver EC subset (Governance & Roles:
 * "approval requires a majority of the designated EC subset", configurable
 * per society). Idempotent -- designating an already-designated member is a
 * no-op, not an error. Does not itself check EC membership: buildClaims
 * below only honors this designation while the member also currently holds
 * an open EC-office role assignment (AC4 -- a designation alone, with no
 * current EC role, confers nothing).
 */
export async function designateApprover(db: Database, memberId: string): Promise<void> {
  await db.execute(
    sql`INSERT INTO capability_approver_designations (member_id) VALUES (${memberId}) ON CONFLICT (member_id) DO NOTHING`,
  );
}

/** Removes `memberId` from the designated-approver EC subset. A no-op if they weren't in it. */
export async function revokeApprover(db: Database, memberId: string): Promise<void> {
  await db.execute(sql`DELETE FROM capability_approver_designations WHERE member_id = ${memberId}`);
}

async function isDesignatedApprover(db: Database, memberId: string): Promise<boolean> {
  const row = await db.queryOne(sql`SELECT member_id FROM capability_approver_designations WHERE member_id = ${memberId}`);
  return row !== null;
}

/**
 * Derives the full set of governance capabilities currently held by
 * `actor`, straight from live state -- no caching, no persisted claims row
 * (T-P1: a pure read of current DB state). Reflects only *current*
 * (open-interval) role assignments and account state (AC4): a vacated EC
 * role or a stripped employee capability drops out immediately, with no
 * separate revocation step.
 *
 * A PC seat (aws-blocks/projects/committees-api.ts) is never consulted --
 * that's the structural half of AC2/TC-MEM-044 ("PC membership confers no
 * capability"): there is no code path here that could grant one from a
 * committee seat, not just a runtime check that happens to deny it.
 */
export async function buildClaims(db: Database, actor: Actor): Promise<GovernanceCapability[]> {
  if ('employeeId' in actor) {
    const employee = await getEmployee(db, actor.employeeId);
    if (!employee) return [];
    const governanceCapabilityNames: readonly string[] = GOVERNANCE_CAPABILITIES;
    return employee.capabilities.filter(c => governanceCapabilityNames.includes(c)) as GovernanceCapability[];
  }

  const openRoles = (await listRoleAssignments(db, { memberId: actor.memberId })).filter(r => r.effectiveTo === null);
  const claims: GovernanceCapability[] = [];

  // finance-recorder defaults to the current Treasurer (Governance & Roles:
  // "Treasurer by default, delegable" -- delegation is additive, via an
  // employee's own finance-recorder capability above, not exclusive with
  // the Treasurer's default grant).
  if (openRoles.some(r => r.role === 'treasurer')) {
    claims.push('finance-recorder');
  }

  const holdsEcOffice = openRoles.some(r => EC_OFFICES.includes(r.role));

  // designated-approver requires both a current EC-office role and the
  // configurable designation -- either alone confers nothing (a plain EC
  // member isn't automatically an approver; a stale designation for
  // someone no longer on the EC confers nothing, per AC4).
  if (holdsEcOffice && (await isDesignatedApprover(db, actor.memberId))) {
    claims.push('designated-approver');
  }

  // STR-132: the society board is EC-only (Communication), while moderation
  // is Management-or-EC -- authority over a post, not authorship of one, so
  // it reaches project boards an EC office confers no posting right on.
  if (holdsEcOffice) {
    claims.push('bulletin_compose');
  }
  if (holdsEcOffice || openRoles.some(r => r.role === 'management')) {
    claims.push('bulletin_moderate');
  }

  return claims;
}

/** The authorization decision itself -- a pure function of the actor's
 * already-derived claims and the capability a call site requires (T-P1). */
export function hasCapability(claims: readonly GovernanceCapability[], capability: GovernanceCapability): boolean {
  return claims.includes(capability);
}

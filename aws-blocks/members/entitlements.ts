// STR-034: status entitlement predicates and derived defaulter standing.
// Pure functions over `MemberStatus` (aws-blocks/members/members-api.ts) --
// no DB access, no HTTP surface (confirmed against both OpenAPI specs: no
// endpoint or schema field anywhere references defaulter/entitlement
// concepts). Domain Model, "Member status lifecycle": pending -- no charge
// accrual, no app invite, cannot hold roles; active -- full access; suspended
// -- charges continue to accrue, may log in and pay, cannot hold roles;
// ceased -- no accrual, no app access. Governance & Roles: role eligibility
// requires `active` status exactly.
//
// This is the single module boundary E05 (STR-041 role gating), E07 (charge
// runs), and M4 onboarding are meant to import from -- no re-derivation
// elsewhere (this story's own Refactor note).
import type { MemberStatus } from './members-api';

/** Charges accrue for `active` and `suspended` members only. */
export function canAccrueCharges(status: MemberStatus): boolean {
  return status === 'active' || status === 'suspended';
}

/** App access (log in, pay dues) holds for `active` and `suspended` members only. */
export function hasAppAccess(status: MemberStatus): boolean {
  return status === 'active' || status === 'suspended';
}

/** Management/EC roles require `active` status exactly -- suspension or cessation vacates eligibility. */
export function isRoleEligible(status: MemberStatus): boolean {
  return status === 'active';
}

/**
 * A charge the caller already knows is outstanding for a member, identified
 * only by its due date -- deliberately minimal, no amount/kind/status, since
 * this story stubs the charge source (no `charges` table exists yet; E07/
 * STR-061 owns building the real one). Once that lands, its own read query
 * becomes the caller supplying this list -- this function itself doesn't
 * change.
 */
export interface OutstandingCharge {
  memberId: string;
  /** YYYY-MM-DD. */
  dueDate: string;
}

/**
 * Defaulter standing, derived at read time from the caller-supplied
 * outstanding-charge list (AC2: no stored defaulter column or flag
 * anywhere -- this function has nothing to persist). Deliberately has no
 * relationship to `hasAppAccess`/`canAccrueCharges` above: nothing in this
 * module gates access on defaulter standing (AC3 -- payment access must
 * never be blocked by it; see the T-U3 regression test asserting exactly
 * that independence).
 */
export function isDefaulter(memberId: string, outstandingCharges: readonly OutstandingCharge[], asOf: string): boolean {
  return outstandingCharges.some(charge => charge.memberId === memberId && charge.dueDate < asOf);
}

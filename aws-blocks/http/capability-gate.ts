// STR-044: the single authorization entry point every protected Admin API
// endpoint declares its required capability to (the story's own Refactor
// note -- no per-endpoint ad hoc checks). Thin HTTP adapter over
// aws-blocks/members/capabilities.ts's buildClaims/hasCapability, mirroring
// the rest of this repo's business-logic/HTTP-adapter split.
//
// Resolves the caller's actor identity from an explicit request header --
// a stand-in for a real JWT `sub` claim until real Cognito auth exists (see
// capabilities.ts's module comment) -- rather than trusting a
// client-declared capability set directly, which is what this replaces
// (aws-blocks/employees/employees-routes.ts's STR-042 `X-Capabilities`
// stub: the caller asserted its own capabilities; here the server derives
// them from live role/employee state instead).
import type { BlocksContext, Database } from '@aws-blocks/blocks';
import { buildClaims, hasCapability, type Actor, type GovernanceCapability } from '../members/capabilities';
import { sendCapabilityRequired } from './problem-response';

/**
 * STR-057: exported for reuse by asset-view-grants-routes.ts, which needs
 * the caller's actor identity recorded in the grant audit trail -- the same
 * header-stub resolution this module already established for capability
 * gating.
 */
export function resolveActor(ctx: BlocksContext): Actor | null {
  const employeeId = ctx.request.headers.get('X-Actor-Employee-Id');
  if (employeeId) return { employeeId };
  const memberId = ctx.request.headers.get('X-Actor-Member-Id');
  if (memberId) return { memberId };
  return null;
}

/**
 * Gates a request on `capability`. Sends the `403 capability_required`
 * response and returns `false` if the resolved actor (or the absence of
 * one) lacks it; a call site must return immediately when this is `false`,
 * exactly like the sendNotFound/sendValidationError helpers it sits beside.
 * Returns `true` if the request may proceed.
 */
export async function requireCapability(ctx: BlocksContext, db: Database, capability: GovernanceCapability): Promise<boolean> {
  const actor = resolveActor(ctx);
  const claims = actor ? await buildClaims(db, actor) : [];
  if (!hasCapability(claims, capability)) {
    sendCapabilityRequired(ctx, capability);
    return false;
  }
  return true;
}

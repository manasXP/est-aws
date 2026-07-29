// STR-044: the single authorization entry point every protected Admin API
// endpoint declares its required capability to (the story's own Refactor
// note -- no per-endpoint ad hoc checks). Thin HTTP adapter over
// aws-blocks/members/capabilities.ts's buildClaims/hasCapability, mirroring
// the rest of this repo's business-logic/HTTP-adapter split.
//
// STR-045: the caller's identity now comes from a verified Cognito access
// token (token-verifier.ts), mapped to the member or employee record carrying
// that pool subject. The `X-Actor-*` request header this module used to read
// is gone with no fallback -- a fallback would preserve exactly the forgery
// it replaced, since any caller can set a header.
import { sql } from '@aws-blocks/blocks';
import type { BlocksContext, Database } from '@aws-blocks/blocks';
import { buildClaims, hasCapability, type Actor, type GovernanceCapability } from '../members/capabilities';
import { problemResponse, sendCapabilityRequired } from './problem-response';
import { bearerToken, cognitoAuthConfig, verifyAccessToken } from './token-verifier';

/**
 * Why a request has no actor. `401` is "we don't know who you are" (no token,
 * or one that doesn't verify against this deployment's pool); `403` is "we do,
 * and you are not an admin user of this society" -- authenticated, but with no
 * member or employee record behind the subject.
 */
export interface ActorRefusal {
  status: 401 | 403;
  code: 'unauthorized' | 'not_an_admin_user';
  message: string;
}

export type ActorResolution = { actor: Actor } | { failure: ActorRefusal };

const UNAUTHORIZED: ActorRefusal = {
  status: 401,
  code: 'unauthorized',
  // Deliberately one message for every rejection reason -- an expired token
  // and a forged one look identical to the caller.
  message: 'A valid bearer access token is required.',
};

/**
 * Resolves the caller from the bearer token's subject. Employees are looked
 * up before members: an employee record is only ever created for staff, so a
 * subject on both would be a provisioning error, and preferring the employee
 * is the narrower reading of it.
 */
export async function resolveActor(ctx: BlocksContext, db: Database): Promise<ActorResolution> {
  const token = bearerToken(ctx.request.headers);
  if (!token) return { failure: UNAUTHORIZED };

  let sub: string;
  try {
    ({ sub } = await verifyAccessToken(token, cognitoAuthConfig()));
  } catch {
    return { failure: UNAUTHORIZED };
  }

  const employee = await db.queryOne<{ id: string }>(sql`SELECT id FROM employees WHERE cognito_sub = ${sub}`);
  if (employee) return { actor: { employeeId: employee.id } };

  const member = await db.queryOne<{ id: string }>(sql`SELECT id FROM members WHERE cognito_sub = ${sub}`);
  if (member) return { actor: { memberId: member.id } };

  return {
    failure: {
      status: 403,
      code: 'not_an_admin_user',
      message: 'This account has no member or employee record in this society.',
    },
  };
}

/** Sends the refusal a failed resolution carries. */
export function sendActorRefusal(ctx: BlocksContext, failure: ActorRefusal): void {
  ctx.response.status = failure.status;
  ctx.response.send(problemResponse(failure.code, failure.message));
}

/**
 * Gates a request on `capability`. Returns the resolved actor when the
 * request may proceed, or `null` after sending the 401/403 -- a call site
 * must return immediately on `null`, exactly like the sendNotFound/
 * sendValidationError helpers it sits beside.
 *
 * STR-045: returns the actor rather than a boolean, so a call site that needs
 * the caller's identity (the invoice and payment routes, for their audit
 * trails) takes it from the resolution the gate already did instead of
 * re-resolving -- which would now mean verifying the token twice.
 */
export async function requireCapability(
  ctx: BlocksContext,
  db: Database,
  capability: GovernanceCapability,
): Promise<Actor | null> {
  const resolution = await resolveActor(ctx, db);
  if ('failure' in resolution) {
    sendActorRefusal(ctx, resolution.failure);
    return null;
  }
  const claims = await buildClaims(db, resolution.actor);
  if (!hasCapability(claims, capability)) {
    sendCapabilityRequired(ctx, capability);
    return null;
  }
  return resolution.actor;
}

/**
 * The plain authentication gate, for the admin routes that carry no
 * capability of their own. The Admin OpenAPI declares `bearerAuth` globally
 * with no per-operation opt-out, so *every* admin operation is gated on
 * identity; a capability is an additional requirement on top, never a
 * replacement for this. Returns the actor so a call site that also records
 * who acted takes it from here rather than resolving (and re-verifying) again.
 */
export async function requireAuthenticated(ctx: BlocksContext, db: Database): Promise<Actor | null> {
  const resolution = await resolveActor(ctx, db);
  if ('failure' in resolution) {
    sendActorRefusal(ctx, resolution.failure);
    return null;
  }
  return resolution.actor;
}

/**
 * Identity-only gates, for the routes with no capability of their own -- the
 * mobile `/me` and `/pc` surfaces (the caller *is* the scope) and the staff
 * routes that only record who acted. An actor of the wrong kind is 403:
 * authenticated, but not the sort of account this route serves.
 */
export async function requireMember(ctx: BlocksContext, db: Database): Promise<string | null> {
  return requireActorOfKind(ctx, db, 'memberId');
}

export async function requireEmployee(ctx: BlocksContext, db: Database): Promise<string | null> {
  return requireActorOfKind(ctx, db, 'employeeId');
}

async function requireActorOfKind(
  ctx: BlocksContext,
  db: Database,
  kind: 'memberId' | 'employeeId',
): Promise<string | null> {
  const resolution = await resolveActor(ctx, db);
  if ('failure' in resolution) {
    sendActorRefusal(ctx, resolution.failure);
    return null;
  }
  if (!(kind in resolution.actor)) {
    sendActorRefusal(ctx, {
      status: 403,
      code: 'not_an_admin_user',
      message: kind === 'memberId' ? 'This endpoint serves members.' : 'This endpoint serves employees.',
    });
    return null;
  }
  return (resolution.actor as Record<string, string>)[kind];
}

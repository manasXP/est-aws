// STR-045: mints Cognito-shaped access tokens and serves the matching JWKS,
// so the token path at the HTTP boundary can be exercised with no AWS account
// and no network (story-tdd-knowledge invariant 6, "local-first").
//
// The pool identity is read from the same place production reads it -- the
// Blocks SDK identifier registry, keyed by the AuthCognito Block's `fullId`
// (`estatly-auth`; scope and block id joined with a hyphen, STR-001's finding)
// -- so a test token is only ever valid against the pool the running app is
// actually configured for. `region` is derived from the pool id's own
// `<region>_<suffix>` shape, which is how a real Cognito pool id is built.
import { createSign, generateKeyPairSync, randomUUID, type JsonWebKey } from 'node:crypto';
import { getSdkIdentifiers, type Database } from '@aws-blocks/blocks';
import { handleManagementAction, ManagementActionError } from '../../aws-blocks/management-actions';
import { createEmployee } from '../../aws-blocks/employees/employees-api';

export const TEST_KID = 'estatly-test-signing-key';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

export interface PoolIdentity {
  userPoolId: string;
  clientId: string;
  region: string;
  issuer: string;
  jwksUri: string;
}

/** The pool the app under test verifies against, resolved the way production does. */
export function poolIdentity(): PoolIdentity {
  const { userPoolId, clientId } = getSdkIdentifiers({ fullId: 'estatly-auth' }) as {
    userPoolId?: string;
    clientId?: string;
  };
  const pool = userPoolId ?? 'unregistered-pool';
  const region = pool.split('_')[0];
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${pool}`;
  return {
    userPoolId: pool,
    clientId: clientId ?? 'unregistered-client',
    region,
    issuer,
    jwksUri: `${issuer}/.well-known/jwks.json`,
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

export interface AccessTokenOverrides {
  kid?: string;
  issuer?: string;
  clientId?: string;
  tokenUse?: string;
  /** Seconds from now; negative mints an already-expired token. */
  expiresInSeconds?: number;
  /** Signs with a throwaway key the served JWKS does not contain. */
  signWithForeignKey?: boolean;
}

/**
 * A Cognito *access* token (`token_use: 'access'`, audience carried as
 * `client_id`, not `aud` -- the shape Cognito actually issues).
 */
export function signAccessToken(sub: string, overrides: AccessTokenOverrides = {}): string {
  const pool = poolIdentity();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: overrides.kid ?? TEST_KID, typ: 'JWT' };
  const payload = {
    sub,
    iss: overrides.issuer ?? pool.issuer,
    client_id: overrides.clientId ?? pool.clientId,
    token_use: overrides.tokenUse ?? 'access',
    iat: now,
    exp: now + (overrides.expiresInSeconds ?? 3600),
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = overrides.signWithForeignKey
    ? generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
    : privateKey;
  const signature = createSign('RSA-SHA256').update(signingInput).end().sign(key);
  return `${signingInput}.${base64url(signature)}`;
}

/** `Authorization: Bearer <token>` for a subject, ready to pass to dispatchRequest. */
export function bearerFor(sub: string, overrides?: AccessTokenOverrides): Record<string, string> {
  return { Authorization: `Bearer ${signAccessToken(sub, overrides)}` };
}

/**
 * Gives an existing employee/member record an admin account and returns the
 * `Authorization` header for it -- the provisioning step every real admin
 * account goes through (`link-admin-account`, aws-blocks/management-actions
 * .ts), so a test never writes `cognito_sub` by a route no operator has.
 *
 * The subject is derived from the record id, so calling this twice for the
 * same person is idempotent and mints an equivalent token both times.
 */
export async function asEmployee(db: Database, employeeId: string): Promise<Record<string, string>> {
  return linkAndSign(db, { employee_id: employeeId }, employeeId);
}

export async function asMember(db: Database, memberId: string): Promise<Record<string, string>> {
  return linkAndSign(db, { member_id: memberId }, memberId);
}

/**
 * A brand-new employee with an admin account, for the many fixtures that need
 * *an* authenticated caller and nothing more -- the document/asset/ticket
 * routes that gate on identity alone (`resolveActor`) rather than on a
 * capability. Under the STR-044 header stand-in these call sites passed a
 * made-up id like `emp-1`, which never had to exist; a token subject must map
 * to a real record, so the record is created here.
 *
 * Call sites that assert *which* actor was recorded should create the record
 * themselves and pass its id to asEmployee/asMember instead, so the assertion
 * names the actor it means.
 */
export async function asNewEmployee(db: Database): Promise<Record<string, string>> {
  const employee = await createEmployee(db, { name: `Test Staff ${randomUUID()}` });
  return asEmployee(db, employee.employee_id);
}

let sharedStaff: Promise<Record<string, string>> | null = null;

/**
 * The same authenticated staff caller for every case in a test file -- for
 * fixtures and read-back helpers that just need to get past the gate. Vitest
 * gives each test file its own module instance, so the memo is per file: one
 * employee record per file rather than one per dispatch, which matters for
 * helpers called several times within a single case.
 *
 * Use asNewEmployee when a case needs a *distinct* caller, and
 * asEmployee/asMember when it asserts which actor was recorded.
 */
export async function asAnyStaff(db: Database): Promise<Record<string, string>> {
  sharedStaff ??= asNewEmployee(db);
  return sharedStaff;
}

async function linkAndSign(
  db: Database,
  who: { employee_id?: string; member_id?: string },
  id: string,
): Promise<Record<string, string>> {
  const sub = `sub-${id}`;
  try {
    await handleManagementAction({ action: 'link-admin-account', ...who, cognito_sub: sub }, db);
  } catch (e) {
    if (e instanceof ManagementActionError) {
      throw new Error(`${e.message} An admin account can only be linked to a record that exists.`);
    }
    throw e;
  }
  return bearerFor(sub);
}

/**
 * Serves this helper's public key at the pool's JWKS endpoint by stubbing
 * `globalThis.fetch` -- no production test seam, the verifier fetches its
 * keys exactly as it would against a real pool.
 */
export function installJwksStub(): void {
  const pool = poolIdentity();
  const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
  const jwks = { keys: [{ ...jwk, kid: TEST_KID, alg: 'RS256', use: 'sig' }] };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === pool.jwksUri) {
      return new Response(JSON.stringify(jwks), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

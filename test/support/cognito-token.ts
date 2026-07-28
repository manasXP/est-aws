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
import { createSign, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { getSdkIdentifiers } from '@aws-blocks/blocks';

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

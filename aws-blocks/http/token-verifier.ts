// STR-045: verifies a Cognito-issued access token at the HTTP boundary and
// hands back its subject. Replaces the STR-044 `X-Actor-*` header stand-in,
// which let any caller assert its own identity.
//
// WHICH TOKEN (AC5): the **access** token, not the id token -- the Admin
// OpenAPI's `bearerAuth` says so ("Cognito-issued access token"). The claims
// read are `sub` (the pool user, mapped to a member/employee by
// capability-gate.ts), `iss`, `client_id`, `token_use` and `exp`. Nothing
// else: capabilities are never read from the token, they are derived from
// live role/employee state by capabilities.ts, so a role change takes effect
// without waiting for a token to expire.
//
// Two Cognito shapes differ from a generic OIDC access token and are easy to
// get wrong: the audience is carried as `client_id`, not `aud`, and
// `token_use` is what distinguishes an access token from an id token (both
// are signed by the same pool with the same keys, so checking the signature
// alone would accept either).
import { createPublicKey, createVerify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { getSdkIdentifiers } from '@aws-blocks/blocks';
import { SCOPE_ID, AUTH_BLOCK_ID } from '../block-ids';

export class TokenVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenVerificationError';
  }
}

export interface CognitoAuthConfig {
  userPoolId: string;
  clientId: string;
  region: string;
  issuer: string;
  jwksUri: string;
}

/**
 * The pool this deployment verifies against, read from the AuthCognito
 * Block's SDK identifiers (keyed by its `fullId` -- scope and block id joined
 * with a hyphen, STR-001's finding). Region comes out of the pool id's own
 * `<region>_<suffix>` shape, so there is no second place to configure it and
 * no way for the two to disagree.
 */
export function cognitoAuthConfig(): CognitoAuthConfig {
  const { userPoolId, clientId } = getSdkIdentifiers({ fullId: `${SCOPE_ID}-${AUTH_BLOCK_ID}` }) as {
    userPoolId?: string;
    clientId?: string;
  };
  if (!userPoolId || !clientId) {
    throw new TokenVerificationError('The AuthCognito Block is not registered — no pool to verify against.');
  }
  const region = userPoolId.split('_')[0];
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`;
  return { userPoolId, clientId, region, issuer, jwksUri: `${issuer}/.well-known/jwks.json` };
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

// Signing keys change rarely (pool creation, key rotation), so they are
// cached per JWKS endpoint. A `kid` the cache doesn't hold triggers exactly
// one refetch -- which is how a rotated key is picked up, and also why an
// unknown-key token costs one fetch rather than being cached as absent.
const jwksCache = new Map<string, Map<string, KeyObject>>();

async function fetchJwks(jwksUri: string): Promise<Map<string, KeyObject>> {
  const response = await fetch(jwksUri);
  if (!response.ok) {
    throw new TokenVerificationError(`Could not fetch signing keys from ${jwksUri} (HTTP ${response.status}).`);
  }
  const { keys } = (await response.json()) as { keys: Jwk[] };
  const byKid = new Map<string, KeyObject>();
  for (const key of keys) {
    if (!key.kid) continue;
    byKid.set(key.kid, createPublicKey({ key: key as JsonWebKey, format: 'jwk' }));
  }
  jwksCache.set(jwksUri, byKid);
  return byKid;
}

async function signingKey(jwksUri: string, kid: string): Promise<KeyObject> {
  const cached = jwksCache.get(jwksUri)?.get(kid);
  if (cached) return cached;
  const refreshed = await fetchJwks(jwksUri);
  const key = refreshed.get(kid);
  if (!key) throw new TokenVerificationError(`No signing key ${kid} published by the pool.`);
  return key;
}

function decodeSegment(segment: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(segment, 'base64url').toString('utf-8')) as Record<string, unknown>;
  } catch {
    throw new TokenVerificationError('Token segment is not valid base64url JSON.');
  }
}

/**
 * Verifies `token` against `config` and returns the pool subject it belongs
 * to. Throws `TokenVerificationError` for every rejection -- the caller turns
 * that into a 401 without distinguishing why, so a probing client learns
 * nothing from the response.
 */
export async function verifyAccessToken(token: string, config: CognitoAuthConfig): Promise<{ sub: string }> {
  const segments = token.split('.');
  if (segments.length !== 3) throw new TokenVerificationError('Token is not a three-segment JWT.');
  const [encodedHeader, encodedPayload, encodedSignature] = segments;

  const header = decodeSegment(encodedHeader);
  if (header.alg !== 'RS256') throw new TokenVerificationError(`Unsupported token algorithm ${String(header.alg)}.`);
  if (typeof header.kid !== 'string') throw new TokenVerificationError('Token header carries no key id.');

  const key = await signingKey(config.jwksUri, header.kid);
  const verified = createVerify('RSA-SHA256')
    .update(`${encodedHeader}.${encodedPayload}`)
    .end()
    .verify(key, Buffer.from(encodedSignature, 'base64url'));
  if (!verified) throw new TokenVerificationError('Token signature does not verify against the pool key.');

  const claims = decodeSegment(encodedPayload);
  if (claims.iss !== config.issuer) throw new TokenVerificationError('Token was issued by a different pool.');
  if (claims.token_use !== 'access') throw new TokenVerificationError('Token is not an access token.');
  if (claims.client_id !== config.clientId) throw new TokenVerificationError('Token was issued to a different app client.');
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) {
    throw new TokenVerificationError('Token has expired.');
  }
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new TokenVerificationError('Token carries no subject.');

  return { sub: claims.sub };
}

/** The bearer token on a request, or `null` if there isn't a well-formed one. */
export function bearerToken(headers: Headers): string | null {
  const authorization = headers.get('Authorization');
  if (!authorization) return null;
  const [scheme, token] = authorization.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

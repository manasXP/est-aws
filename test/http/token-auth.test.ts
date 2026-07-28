import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, type BlocksContext } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { handleManagementAction } from '../../aws-blocks/management-actions';
import { dispatchRequest } from '../support/dispatch';
import { bearerFor, installJwksStub } from '../support/cognito-token';
import { resolveActor } from '../../aws-blocks/http/capability-gate';
import { buildClaims } from '../../aws-blocks/members/capabilities';
import { createEmployee, setEmployeeCapabilities } from '../../aws-blocks/employees/employees-api';
import { createMember, admitMember } from '../../aws-blocks/members/members-api';
import { createProject } from '../../aws-blocks/projects/projects-api';
import { createAsset } from '../../aws-blocks/assets/assets-api';
import { createOwnership } from '../../aws-blocks/assets/ownerships-api';
import { setProjectCommittee } from '../../aws-blocks/projects/committees-api';

// STR-045 -- Cognito token verification and token-derived actor identity.
// The identity half of E05: STR-044 built the capability decision but left
// the caller asserting its own identity through an `X-Actor-*` header. These
// cases put a verified token under it.
//
// Runs against the shared `db` singleton the registered RawRoutes read from
// (aws-blocks/index.ts), the approach test/contract/offline-payments.contract
// .test.ts established for route-level cases. No AWS and no network: the pool
// identity comes from the AuthCognito Block's local mock identifiers and the
// JWKS is served from an in-process stub (test/support/cognito-token.ts).
//
// T-U1..T-U6 are genuine-gap IDs -- TC-MEM has no case for admin-surface
// token authentication, since every case there assumes an already-identified
// actor (the story's own Context note). T-U5 is the exception and cites its
// existing case.

const MONEY_ROUTE = (chargeId: string) => `/v1/charges/${chargeId}/offline-payment`;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
  await db.execute(sql`UPDATE society_settings SET receipt_prefix = 'SOC' WHERE id = 'default'`);
  installJwksStub();
});

/** A `due` charge to point money actions at -- there is no charge-creation endpoint. */
async function seedDueCharge(amount = '1250.00'): Promise<string> {
  const project = await createProject(db, { name: `STR-045 Project ${randomUUID()}` });
  const member = await createMember(db, { name: `STR-045 Owner ${randomUUID()}` });
  const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: `A-${randomUUID().slice(0, 8)}` });
  const ownership = await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
  const id = randomUUID();
  await db.execute(
    sql`INSERT INTO charges (id, member_id, ownership_id, amount, due_date, status)
        VALUES (${id}, ${member.member_id}, ${ownership.ownership_id}, ${amount}, '2026-08-01', 'due')`,
  );
  return id;
}

/** An employee holding `finance-recorder`, with a pool subject linked through
 * the provisioning management action (the story's seeding path). */
async function financeRecorderWithSubject(): Promise<{ employeeId: string; sub: string }> {
  const employee = await createEmployee(db, { name: `STR-045 Recorder ${randomUUID()}` });
  await setEmployeeCapabilities(db, employee.employee_id, ['finance-recorder']);
  const sub = randomUUID();
  await handleManagementAction({ action: 'link-admin-account', employee_id: employee.employee_id, cognito_sub: sub }, db);
  return { employeeId: employee.employee_id, sub };
}

/** A minimal context, for the cases that assert on the resolution itself
 * rather than on a route's response. */
function contextWithHeaders(headers: Record<string, string>): BlocksContext {
  return {
    request: {
      headers: new Headers(headers),
      body: null,
      json: async () => ({}),
      text: async () => '',
      url: new URL('http://localhost/v1/health'),
      params: {},
    },
    response: { headers: new Headers(), status: 200, send: () => {} },
  } as BlocksContext;
}

describe('STR-045 T-U1 -- an unverifiable token is rejected 401 before any capability check', () => {
  const unverifiable: Array<[string, Record<string, string>]> = [
    ['absent', {}],
    ['malformed', { Authorization: 'Bearer not-a-jwt' }],
    ['not a bearer scheme', { Authorization: `Basic ${Buffer.from('a:b').toString('base64')}` }],
    ['expired', bearerFor(randomUUID(), { expiresInSeconds: -60 })],
    ['issued by a different pool', bearerFor(randomUUID(), { issuer: 'https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_OtherPool' })],
    ['issued to a different app client', bearerFor(randomUUID(), { clientId: 'some-other-client' })],
    ['an id token, not an access token', bearerFor(randomUUID(), { tokenUse: 'id' })],
    ['signed by a key the pool does not publish', bearerFor(randomUUID(), { signWithForeignKey: true })],
  ];

  for (const [label, headers] of unverifiable) {
    it(`rejects a token that is ${label}`, async () => {
      const chargeId = await seedDueCharge();
      const response = await dispatchRequest(
        'POST',
        MONEY_ROUTE(chargeId),
        { method: 'cash', amount: '1250.00', received_on: '2026-08-05' },
        { 'Idempotency-Key': randomUUID(), ...headers },
      );

      // 401, never 403 -- a 403 would mean the capability check ran, which it
      // must not for a caller whose identity was never established.
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ error: { code: 'unauthorized', message: expect.any(String) } });
    });
  }

  it('resolves no actor at all for an unverifiable token', async () => {
    const resolution = await resolveActor(contextWithHeaders({ Authorization: 'Bearer not-a-jwt' }), db);
    expect(resolution).toEqual({ failure: { status: 401, code: 'unauthorized', message: expect.any(String) } });
  });
});

describe('STR-045 T-U2 -- a verified subject resolves the Actor shape buildClaims already consumes', () => {
  it('resolves an employee subject to { employeeId }', async () => {
    const { employeeId, sub } = await financeRecorderWithSubject();

    const resolution = await resolveActor(contextWithHeaders(bearerFor(sub)), db);

    expect(resolution).toEqual({ actor: { employeeId } });
  });

  it('derives exactly the claims the actor already had, so no capability decision changes meaning', async () => {
    const { employeeId, sub } = await financeRecorderWithSubject();

    const resolution = await resolveActor(contextWithHeaders(bearerFor(sub)), db);
    const tokenDerived = await buildClaims(db, (resolution as { actor: { employeeId: string } }).actor);

    expect(tokenDerived).toEqual(await buildClaims(db, { employeeId }));
    expect(tokenDerived).toContain('finance-recorder');
  });

  it('lets that actor post the money action its capability allows', async () => {
    const chargeId = await seedDueCharge('1250.00');
    const { sub } = await financeRecorderWithSubject();

    const response = await dispatchRequest(
      'POST',
      MONEY_ROUTE(chargeId),
      { method: 'cash', amount: '1250.00', received_on: '2026-08-05' },
      { 'Idempotency-Key': randomUUID(), ...bearerFor(sub) },
    );

    expect(response.status).toBe(201);
  });
});

describe('STR-045 T-U3 -- a verified subject with no admin record is 403, not 401', () => {
  it('answers 403 for a token whose subject maps to no member or employee', async () => {
    const chargeId = await seedDueCharge();

    const response = await dispatchRequest(
      'POST',
      MONEY_ROUTE(chargeId),
      { method: 'cash', amount: '1250.00', received_on: '2026-08-05' },
      { 'Idempotency-Key': randomUUID(), ...bearerFor(randomUUID()) },
    );

    // Authenticated -- the token verified -- but not an admin user of this
    // society, which is an authorization outcome, not an authentication one.
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { code: 'not_an_admin_user', message: expect.any(String) } });
  });
});

describe('STR-045 T-U4 -- headers cannot influence identity', () => {
  it('resolves the token subject, not the actor named in a forged X-Actor-Employee-Id', async () => {
    const actorA = await financeRecorderWithSubject();
    const actorB = await financeRecorderWithSubject();

    const resolution = await resolveActor(
      contextWithHeaders({ ...bearerFor(actorA.sub), 'X-Actor-Employee-Id': actorB.employeeId }),
      db,
    );

    expect(resolution).toEqual({ actor: { employeeId: actorA.employeeId } });
  });

  it('does not let a forged header authenticate a request carrying no token', async () => {
    const { employeeId } = await financeRecorderWithSubject();
    const chargeId = await seedDueCharge();

    const response = await dispatchRequest(
      'POST',
      MONEY_ROUTE(chargeId),
      { method: 'cash', amount: '1250.00', received_on: '2026-08-05' },
      { 'Idempotency-Key': randomUUID(), 'X-Actor-Employee-Id': employeeId },
    );

    expect(response.status).toBe(401);
  });
});

describe('STR-045 T-U5 -- a PC member token confers no admin capability (covers TC-MEM-044)', () => {
  it('answers 403 capability_required on a money action, with identity now token-derived', async () => {
    const project = await createProject(db, { name: `STR-045 PC Project ${randomUUID()}` });
    const member = await createMember(db, { name: `STR-045 PC Member ${randomUUID()}` });
    await admitMember(db, member.member_id);
    const asset = await createAsset(db, { project_id: project.project_id, type: 'flat', label: `P-${randomUUID().slice(0, 8)}` });
    await createOwnership(db, member.member_id, { asset_id: asset.asset_id });
    await setProjectCommittee(
      db,
      project.project_id,
      { chair_member_id: member.member_id, member_ids: [member.member_id] },
      // The real port is STR-057's; seeding a seat is setup here, not the
      // behavior under test (test/contract/pc-assets.contract.test.ts's
      // established pattern).
      { ownershipLookup: async () => true },
    );

    const sub = randomUUID();
    await handleManagementAction({ action: 'link-admin-account', member_id: member.member_id, cognito_sub: sub }, db);
    const chargeId = await seedDueCharge();

    const response = await dispatchRequest(
      'POST',
      MONEY_ROUTE(chargeId),
      { method: 'cash', amount: '1250.00', received_on: '2026-08-05' },
      { 'Idempotency-Key': randomUUID(), ...bearerFor(sub) },
    );

    // Authenticated -- the PC member is a real, token-identified actor, so
    // this is the capability boundary refusing them, not the token check.
    expect(await resolveActor(contextWithHeaders(bearerFor(sub)), db)).toEqual({ actor: { memberId: member.member_id } });
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: { code: 'capability_required', message: expect.stringContaining('finance-recorder') } });
  });
});

describe('STR-045 T-U6 -- the header stand-in is gone, not kept as a fallback (AC1)', () => {
  it('has no X-Actor-* header left anywhere in the source tree', async () => {
    const roots = [join(REPO_ROOT, 'aws-blocks'), join(REPO_ROOT, 'test')];
    const offenders: string[] = [];

    for (const root of roots) {
      for (const file of await readdir(root, { recursive: true, withFileTypes: true })) {
        if (!file.isFile() || !file.name.endsWith('.ts')) continue;
        const path = join(file.parentPath, file.name);
        if (path === fileURLToPath(import.meta.url)) continue; // this file names the header to assert its absence
        if (/X-Actor-/.test(await readFile(path, 'utf-8'))) offenders.push(relative(REPO_ROOT, path));
      }
    }

    // A fallback would preserve exactly the forgery this story removes, so
    // absence is the assertion -- not "the token wins when both are present",
    // which T-U4 already covers.
    expect(offenders).toEqual([]);
  });
});

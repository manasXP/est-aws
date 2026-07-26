import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';

// STR-031 — Admin API member CRUD contract cases. Uses the real `db`
// singleton the registered RawRoutes read from (aws-blocks/index.ts), the
// same approach as test/contract/books.contract.test.ts: dispatch the real
// handler, feed its response through the harness.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

describe('STR-031 T-C1 — admin member CRUD API contract', () => {
  it('POST /v1/members creates a pending member with the brief attributes', async () => {
    const name = `Contract Test Member ${randomUUID()}`;
    const response = await dispatchRequest('POST', '/v1/members', {
      name,
      email: 'contract@example.com',
      phone: '9000000000',
      address: '1 Test Lane',
    });

    expect(response.status).toBe(201);
    const body = response.body as Record<string, unknown>;
    expect(body.member_id).toEqual(expect.any(String));
    expect(body.name).toBe(name);
    expect(body.member_status).toBe('pending');
    expect(body.joining_date).toBeNull();

    // Known spec gap (see final report): the Admin OpenAPI's Member schema
    // types `joining_date` as `{ type: string, format: date }` with no
    // `null` in the type union — unlike this same schema file's other
    // nullable fields (Member.cessation_reason, Page.next_cursor,
    // ProjectCommittee.chair_member_id/updated_at all use
    // `type: [string, "null"]`). The domain model requires joining_date to
    // be null until admission (STR-032's lifecycle function), so a freshly
    // created member can never validate against this schema as written.
    // Pinned here (rather than silently skipped) so a future spec fix
    // shows up as a test needing an update, not a silently-passing gap.
    const op = await contractTest('admin', '/members', 'post');
    expect(() => op.expectValidResponse(201, body)).toThrow(/joining_date/);
  });

  it('GET /v1/members/{memberId} and PATCH conform to the Admin OpenAPI for an admitted member', async () => {
    // Seeded directly (bypassing the API): STR-032's lifecycle function,
    // the only writer of member_status/joining_date past creation, doesn't
    // exist yet, so this is the only way to exercise the schema's fully
    // populated (non-null joining_date) shape in this story.
    const id = randomUUID();
    await db.execute(
      sql`INSERT INTO members (id, name, member_status, joining_date) VALUES (${id}, 'Seeded Active Member', 'active', '2026-01-15')`,
    );

    const getResponse = await dispatchRequest('GET', `/v1/members/${id}`);
    const getOp = await contractTest('admin', '/members/{memberId}', 'get');
    expect(() => getOp.expectValidResponse(getResponse.status, getResponse.body)).not.toThrow();

    const patchResponse = await dispatchRequest('PATCH', `/v1/members/${id}`, { phone: '9111111111' });
    const patchOp = await contractTest('admin', '/members/{memberId}', 'patch');
    expect(() => patchOp.expectValidResponse(patchResponse.status, patchResponse.body)).not.toThrow();
    expect((patchResponse.body as Record<string, unknown>).phone).toBe('9111111111');
  });

  it('GET /v1/members?status=active conforms to the Admin OpenAPI (sidesteps the joining_date gap above by construction)', async () => {
    const id = randomUUID();
    await db.execute(
      sql`INSERT INTO members (id, name, member_status, joining_date) VALUES (${id}, 'Seeded Active Member For List', 'active', '2026-02-01')`,
    );

    const response = await dispatchRequest('GET', '/v1/members?status=active');
    const op = await contractTest('admin', '/members', 'get');
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
    expect((response.body as { items: { member_id: string }[] }).items.some(m => m.member_id === id)).toBe(true);
  });
});

// STR-032 T-C1: the lifecycle actions on /v1/members/{memberId} conform to
// the Admin OpenAPI surface (covers TC-MEM-001, TC-MEM-003, TC-MEM-009).
describe('STR-032 T-C1 — admit/suspend/reinstate contract', () => {
  it('POST /v1/members/{memberId}/admit conforms for a pending member (covers TC-MEM-001)', async () => {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO members (id, name, member_status) VALUES (${id}, 'Contract Admit Member', 'pending')`);

    const response = await dispatchRequest('POST', `/v1/members/${id}/admit`);
    expect(response.status).toBe(200);

    const op = await contractTest('admin', '/members/{memberId}/admit', 'post');
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST /v1/members/{memberId}/suspend then /reinstate conform for an active member (covers TC-MEM-003)', async () => {
    // joining_date seeded (sidesteps the known Member.joining_date
    // non-nullable-schema gap noted above, same as the other seeded-active
    // cases in this file) -- suspend/reinstate never touch it.
    const id = randomUUID();
    await db.execute(
      sql`INSERT INTO members (id, name, member_status, joining_date) VALUES (${id}, 'Contract Suspend Member', 'active', '2026-03-01')`,
    );

    const suspendResponse = await dispatchRequest('POST', `/v1/members/${id}/suspend`, { actor: 'ec-member-1' });
    expect(suspendResponse.status).toBe(200);
    const suspendOp = await contractTest('admin', '/members/{memberId}/suspend', 'post');
    expect(() => suspendOp.expectValidResponse(suspendResponse.status, suspendResponse.body)).not.toThrow();

    const reinstateResponse = await dispatchRequest('POST', `/v1/members/${id}/reinstate`, { actor: 'ec-member-2' });
    expect(reinstateResponse.status).toBe(200);
    const reinstateOp = await contractTest('admin', '/members/{memberId}/reinstate', 'post');
    expect(() => reinstateOp.expectValidResponse(reinstateResponse.status, reinstateResponse.body)).not.toThrow();
  });

  it('POST /v1/members/{memberId}/suspend on a pending member returns 409 Conflict (covers TC-MEM-009)', async () => {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO members (id, name, member_status) VALUES (${id}, 'Contract Pending Member', 'pending')`);

    const response = await dispatchRequest('POST', `/v1/members/${id}/suspend`, { actor: 'ec-member-1' });
    expect(response.status).toBe(409);

    const op = await contractTest('admin', '/members/{memberId}/suspend', 'post');
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('POST /v1/members/{memberId}/suspend with a missing actor returns 422 Invalid', async () => {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO members (id, name, member_status) VALUES (${id}, 'Contract Missing Actor Member', 'active')`);

    const response = await dispatchRequest('POST', `/v1/members/${id}/suspend`, {});
    expect(response.status).toBe(422);

    const op = await contractTest('admin', '/members/{memberId}/suspend', 'post');
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });
});

describe('STR-031 code review — POST /v1/members rejects a missing name', () => {
  it('returns 422 conforming to the Admin OpenAPI Invalid response', async () => {
    const response = await dispatchRequest('POST', '/v1/members', { email: 'noname@example.com' });
    expect(response.status).toBe(422);

    const op = await contractTest('admin', '/members', 'post');
    expect(() => op.expectValidResponse(422, response.body)).not.toThrow();
  });
});

describe('STR-031 T-C3 — member_status is lifecycle-only; PATCH rejects it', () => {
  it('rejects a PATCH containing member_status regardless of the value carried', async () => {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO members (id, name, member_status) VALUES (${id}, 'Reject Status Patch Member', 'pending')`);

    const response = await dispatchRequest('PATCH', `/v1/members/${id}`, { member_status: 'active' });
    expect(response.status).toBe(422);

    const op = await contractTest('admin', '/members/{memberId}', 'patch');
    expect(() => op.expectValidResponse(422, response.body)).not.toThrow();
  });
});

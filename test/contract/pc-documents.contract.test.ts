import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import '../../aws-blocks/index';
import { db } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { setProjectCommittee } from '../../aws-blocks/projects/committees-api';
import { contractTest } from './harness';
import { dispatchRequest } from '../support/dispatch';
import { asAnyStaff, asMember, asNewEmployee } from '../support/cognito-token';

// STR-116 T-C1 (BE-C, covers TC-DOC-043) — mobile
// GET /pc/projects/{projectId}/documents against the PcDocument schema,
// following STR-057's pc-assets contract template (incl. its
// setProjectCommittee-with-permissive-lookup seating workaround while the
// committee PUT route still 422s). Fresh project per test keeps exact-list
// assertions safe in the shared singleton db.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function createProject(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/projects', { name: `STR-116 Contract Project ${randomUUID()}` }, await asAnyStaff(db));
  return (response.body as { project_id: string }).project_id;
}

async function createActiveMember(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/members', { name: `STR-116 Contract Member ${randomUUID()}` }, await asAnyStaff(db));
  const memberId = (response.body as { member_id: string }).member_id;
  await dispatchRequest('POST', `/v1/members/${memberId}/admit`, {}, await asAnyStaff(db));
  return memberId;
}

async function seatPc(projectId: string, memberIds: string[]): Promise<void> {
  await setProjectCommittee(
    db,
    projectId,
    { chair_member_id: memberIds[0], member_ids: memberIds },
    { ownershipLookup: async () => true },
  );
}

async function registerProjectDoc(projectId: string, title: string, extras: Record<string, unknown> = {}): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/documents', {
    level: 'project',
    project_id: projectId,
    title,
    category: 'Correspondence',
    filename: 'fixture.pdf',
    content_type: 'application/pdf',
    ...extras,
  }, { ...(await asNewEmployee(db)) });
  return (response.body as { document_id: string }).document_id;
}

describe('STR-116 T-C1 — PC project documents listing contract (covers TC-DOC-043)', () => {
  it('returns ALL the project active documents for a PC member — member_visible does not gate — per the PcDocument schema', async () => {
    const projectId = await createProject();
    const pcMember = await createActiveMember();
    await seatPc(projectId, [pcMember]);
    const hidden = await registerProjectDoc(projectId, 'Hidden from members at large', { member_visible: false });
    const visible = await registerProjectDoc(projectId, 'Visible to members', { member_visible: true });

    const response = await dispatchRequest('GET', `/v1/pc/projects/${projectId}/documents`, {}, { ...(await asMember(db, pcMember)) });

    const op = await contractTest('mobile', '/pc/projects/{projectId}/documents', 'get');
    expect(response.status).toBe(200);
    const ids = (response.body as { items: { document_id: string }[] }).items.map(d => d.document_id).sort();
    expect(ids).toEqual([hidden, visible].sort());
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('honors q and category with the same semantics as the admin registry', async () => {
    const projectId = await createProject();
    const pcMember = await createActiveMember();
    await seatPc(projectId, [pcMember]);
    const lift = await registerProjectDoc(projectId, 'Lift refurbishment quotation');
    const garden = await registerProjectDoc(projectId, 'Garden layout approval');

    const byQ = await dispatchRequest('GET', `/v1/pc/projects/${projectId}/documents?q=refurbishment`, {}, { ...(await asMember(db, pcMember)) });
    const byCategory = await dispatchRequest('GET', `/v1/pc/projects/${projectId}/documents?category=Correspondence`, {}, { ...(await asMember(db, pcMember)) });

    const op = await contractTest('mobile', '/pc/projects/{projectId}/documents', 'get');
    expect((byQ.body as { items: { document_id: string }[] }).items.map(d => d.document_id)).toEqual([lift]);
    const categoryIds = (byCategory.body as { items: { document_id: string }[] }).items.map(d => d.document_id);
    expect(categoryIds).toContain(lift);
    expect(categoryIds).toContain(garden);
    expect(() => op.expectValidResponse(byQ.status, byQ.body)).not.toThrow();
  });

  it('403s a caller not on that project PC, per the Forbidden schema', async () => {
    const projectId = await createProject();
    const pcMember = await createActiveMember();
    const outsider = await createActiveMember();
    await seatPc(projectId, [pcMember]);
    await registerProjectDoc(projectId, 'PC-only paper');

    const response = await dispatchRequest('GET', `/v1/pc/projects/${projectId}/documents`, {}, { ...(await asMember(db, outsider)) });

    const op = await contractTest('mobile', '/pc/projects/{projectId}/documents', 'get');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: 'capability_required' } });
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('404s an unknown project per the NotFound schema', async () => {
    const pcMember = await createActiveMember();

    const response = await dispatchRequest('GET', `/v1/pc/projects/${randomUUID()}/documents`, {}, { ...(await asMember(db, pcMember)) });

    const op = await contractTest('mobile', '/pc/projects/{projectId}/documents', 'get');
    expect(response.status).toBe(404);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });

  it('download 403 (non-PC caller) and 404 (archived, PC member) bodies conform to their declared schemas', async () => {
    const projectId = await createProject();
    const pcMember = await createActiveMember();
    const outsider = await createActiveMember();
    await seatPc(projectId, [pcMember]);
    const documentId = await registerProjectDoc(projectId, 'Gate-checked evidence');

    const op = await contractTest('mobile', '/pc/documents/{documentId}/download', 'get');

    const forbidden = await dispatchRequest('GET', `/v1/pc/documents/${documentId}/download`, {}, { ...(await asMember(db, outsider)) });
    expect(forbidden.status).toBe(403);
    expect(() => op.expectValidResponse(forbidden.status, forbidden.body)).not.toThrow();

    await dispatchRequest('POST', `/v1/documents/${documentId}/archive`, {}, await asAnyStaff(db));
    const archived404 = await dispatchRequest('GET', `/v1/pc/documents/${documentId}/download`, {}, { ...(await asMember(db, pcMember)) });
    expect(archived404.status).toBe(404);
    expect(() => op.expectValidResponse(archived404.status, archived404.body)).not.toThrow();
  });

  it('GET /pc/documents/{documentId}/download conforms to the declared 200 shape for a PC member', async () => {
    const projectId = await createProject();
    const pcMember = await createActiveMember();
    await seatPc(projectId, [pcMember]);
    const documentId = await registerProjectDoc(projectId, 'Downloadable evidence');
    const { sql } = await import('@aws-blocks/blocks');
    const { documents } = await import('../../aws-blocks/index');
    const row = await db.queryOne<{ file_key: string }>(sql`SELECT file_key FROM documents WHERE id = ${documentId}`);
    await documents.put(row!.file_key, 'evidence bytes', { contentType: 'application/pdf' });

    const response = await dispatchRequest('GET', `/v1/pc/documents/${documentId}/download`, {}, { ...(await asMember(db, pcMember)) });

    const op = await contractTest('mobile', '/pc/documents/{documentId}/download', 'get');
    expect(response.status).toBe(200);
    expect(() => op.expectValidResponse(response.status, response.body)).not.toThrow();
  });
});

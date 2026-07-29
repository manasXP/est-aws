import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@aws-blocks/blocks';
import '../../aws-blocks/index';
import { db, documents } from '../../aws-blocks/index';
import { runLocalMigrations, MIGRATIONS_DIR } from '../../aws-blocks/migrations-runner';
import { setProjectCommittee } from '../../aws-blocks/projects/committees-api';
import { dispatchRequest } from '../support/dispatch';
import { asAnyStaff, asMember, asNewEmployee } from '../support/cognito-token';

// STR-116 — PC project document read surface, unit cases (T-U1..T-U3).
// These routes are thin gates over STR-111/114/115's document functions, so
// the behavior under test IS the HTTP gate: everything goes through the
// real handlers via dispatchRequest against the singleton `db`, the same
// approach as STR-057's PC asset surface (test/contract/
// pc-assets.contract.test.ts, incl. its setProjectCommittee-with-permissive-
// lookup seating workaround while the committee PUT route still 422s).
// Every fixture project/member is freshly created per test, so exact-list
// assertions are safe against .bb-data accumulation.

beforeAll(async () => {
  await runLocalMigrations(db, MIGRATIONS_DIR);
});

async function createProject(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/projects', { name: `STR-116 Project ${randomUUID()}` }, await asAnyStaff(db));
  return (response.body as { project_id: string }).project_id;
}

async function createActiveMember(): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/members', { name: `STR-116 Member ${randomUUID()}` }, await asAnyStaff(db));
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

interface RegisterDocOptions {
  level?: string;
  projectId?: string;
  memberId?: string;
  title?: string;
  memberVisible?: boolean;
  upload?: boolean;
}

/** Registers a document through the real POST handler; `upload: true` also
 * lands bytes at its file_key so the presigned-download path is live. */
async function registerDoc(options: RegisterDocOptions = {}): Promise<string> {
  const response = await dispatchRequest('POST', '/v1/documents', {
    level: options.level ?? 'project',
    ...(options.projectId && { project_id: options.projectId }),
    ...(options.memberId && { member_id: options.memberId }),
    title: options.title ?? `Fixture ${randomUUID()}`,
    category: 'Correspondence',
    ...(options.memberVisible !== undefined && { member_visible: options.memberVisible }),
    filename: 'fixture.pdf',
    content_type: 'application/pdf',
  }, { ...(await asNewEmployee(db)) });
  expect(response.status).toBe(201);
  const documentId = (response.body as { document_id: string }).document_id;
  if (options.upload) {
    const row = await db.queryOne<{ file_key: string }>(sql`SELECT file_key FROM documents WHERE id = ${documentId}`);
    await documents.put(row!.file_key, 'fixture bytes', { contentType: 'application/pdf' });
  }
  return documentId;
}

function listedIds(body: unknown): string[] {
  return (body as { items: { document_id: string }[] }).items.map(d => d.document_id);
}

describe('STR-116 T-U1 (TC-DOC-044) — PC download gate', () => {
  it('succeeds for a member sitting on the document project PC', async () => {
    const projectId = await createProject();
    const pcMember = await createActiveMember();
    await seatPc(projectId, [pcMember]);
    const documentId = await registerDoc({ projectId, upload: true });

    const response = await dispatchRequest('GET', `/v1/pc/documents/${documentId}/download`, {}, { ...(await asMember(db, pcMember)) });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ url: expect.any(String), expires_at: expect.any(String) });
  });

  it('403s for an admitted member not on any PC', async () => {
    const projectId = await createProject();
    const pcMember = await createActiveMember();
    const outsider = await createActiveMember();
    await seatPc(projectId, [pcMember]);
    const documentId = await registerDoc({ projectId, upload: true });

    const response = await dispatchRequest('GET', `/v1/pc/documents/${documentId}/download`, {}, { ...(await asMember(db, outsider)) });

    expect(response.status).toBe(403);
  });

  it('403s for a member who sits on a DIFFERENT project PC', async () => {
    const projectId = await createProject();
    const otherProjectId = await createProject();
    const pcMember = await createActiveMember();
    const otherPcMember = await createActiveMember();
    await seatPc(projectId, [pcMember]);
    await seatPc(otherProjectId, [otherPcMember]);
    const documentId = await registerDoc({ projectId, upload: true });

    const response = await dispatchRequest('GET', `/v1/pc/documents/${documentId}/download`, {}, { ...(await asMember(db, otherPcMember)) });

    expect(response.status).toBe(403);
  });

  it('403s for a society-level document even for a PC member', async () => {
    const projectId = await createProject();
    const pcMember = await createActiveMember();
    await seatPc(projectId, [pcMember]);
    const documentId = await registerDoc({ level: 'society', upload: true });

    const response = await dispatchRequest('GET', `/v1/pc/documents/${documentId}/download`, {}, { ...(await asMember(db, pcMember)) });

    expect(response.status).toBe(403);
  });

  it('404s for a nonexistent document', async () => {
    const pcMember = await createActiveMember();

    const response = await dispatchRequest('GET', '/v1/pc/documents/no-such-document/download', {}, { ...(await asMember(db, pcMember)) });

    expect(response.status).toBe(404);
  });
});

describe('STR-116 T-U2 — the PC listing is scoped to the project own project-level documents', () => {
  it('never surfaces society-level, member-level, or other-project documents', async () => {
    const projectId = await createProject();
    const otherProjectId = await createProject();
    const pcMember = await createActiveMember();
    const someMember = await createActiveMember();
    await seatPc(projectId, [pcMember]);

    const own = await registerDoc({ projectId });
    await registerDoc({ level: 'society' });
    await registerDoc({ level: 'member', memberId: someMember });
    await registerDoc({ projectId: otherProjectId });

    const response = await dispatchRequest('GET', `/v1/pc/projects/${projectId}/documents`, {}, { ...(await asMember(db, pcMember)) });

    expect(response.status).toBe(200);
    expect(listedIds(response.body)).toEqual([own]);
  });
});

describe('STR-116 T-U3 — archived documents are invisible on the PC surface', () => {
  it('excludes an archived project document from the listing, like the admin active-only default', async () => {
    const projectId = await createProject();
    const pcMember = await createActiveMember();
    await seatPc(projectId, [pcMember]);
    const kept = await registerDoc({ projectId });
    const archived = await registerDoc({ projectId });
    await dispatchRequest('POST', `/v1/documents/${archived}/archive`, {}, await asAnyStaff(db));

    const response = await dispatchRequest('GET', `/v1/pc/projects/${projectId}/documents`, {}, { ...(await asMember(db, pcMember)) });

    expect(listedIds(response.body)).toEqual([kept]);
  });

  it('404s an archived document on the PC download route — invisible on this surface entirely', async () => {
    // The story asks the download route to reject archived docs
    // "consistently" with their absence from the listing; 404 (not 403) so
    // the PC surface neither serves nor confirms what it does not list.
    const projectId = await createProject();
    const pcMember = await createActiveMember();
    await seatPc(projectId, [pcMember]);
    const archived = await registerDoc({ projectId, upload: true });
    await dispatchRequest('POST', `/v1/documents/${archived}/archive`, {}, await asAnyStaff(db));

    const response = await dispatchRequest('GET', `/v1/pc/documents/${archived}/download`, {}, { ...(await asMember(db, pcMember)) });

    expect(response.status).toBe(404);
  });
});
